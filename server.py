#!/usr/bin/env python3
"""Local Inservo viewer.

The hosted player fires the next request before the previous one finishes,
and it asks every storage server on every tick. This server is the only
thing that talks to Inservo, and it allows one upstream request at a time.
The browser waits for each response, then for the picture itself.
"""

import http.client
import json
import re
import secrets
import ssl
import sys
import threading
import time
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime, timedelta
from http.client import HTTPMessage
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo

ORIGIN = "https://app.inservo.ee"
SERVERS = {
    "s3": "https://s3.c1.app.inservo.ee",
    "s4": "https://s4.c1.app.inservo.ee",
    "s5": "https://s5.c1.app.inservo.ee",
}
TZ = ZoneInfo("Europe/Tallinn")
STATIC = Path(__file__).resolve().parent / "static"
FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/sw.js": ("sw.js", "text/javascript; charset=utf-8"),
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/icon-192.png": ("icon-192.png", "image/png"),
    "/icon-512.png": ("icon-512.png", "image/png"),
    "/icon-maskable-512.png": ("icon-maskable-512.png", "image/png"),
}
MAX_WINDOW = 300
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_CACHE = 40 * 1024 * 1024
USER_AGENT = "InservoLocalClient/1.0"
SESSION_COOKIE = "inservo_session"
SESSION_MAX_AGE = 30 * 24 * 60 * 60

_SSL = ssl.create_default_context()


class UpstreamError(Exception):
    pass


class AuthError(Exception):
    pass


class Inservo:
    """One signed-in session. All methods expect the caller to hold `lock`."""

    def __init__(self):
        self.lock = threading.Lock()
        self.jar = CookieJar()
        self.conns = {}
        self.logged_in = False
        self.offset = 0.0
        self.hot = {}
        self.full_probe_at = {}
        self.frame_cache = OrderedDict()
        self.image_cache = OrderedDict()
        self.image_bytes = 0

    def login(self, username, password):
        self.jar.clear()
        self.conns.clear()
        self.logged_in = False
        self.hot.clear()
        self.frame_cache.clear()
        self._drop_images()
        status, _, page = self._request("GET", ORIGIN + "/site/login")
        html = page.decode("utf-8", "replace")
        if status != 200:
            raise UpstreamError("Login page did not load (HTTP %s)." % status)
        match = re.search(r'name="_csrf-frontend" value="([^"]+)"', html)
        if not match:
            raise UpstreamError("Login page had no security token.")
        body = urllib.parse.urlencode(
            {
                "_csrf-frontend": match.group(1),
                "LoginForm[username]": username,
                "LoginForm[password]": password,
                "login-button": "Sisene",
            }
        ).encode()
        _, _, posted = self._request(
            "POST",
            ORIGIN + "/site/login",
            body=body,
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": ORIGIN + "/site/login",
                "Origin": ORIGIN,
            },
        )
        html = posted.decode("utf-8", "replace")
        cameras = self._json("GET", ORIGIN + "/ajax/cameras")
        if not cameras or cameras.get("error") or not isinstance(cameras.get("data"), list):
            self.jar.clear()
            message = _login_message(html)
            return False, message or "Email or password was not accepted."
        try:
            self._refresh_offset()
        except UpstreamError:
            self.offset = 0.0
        self.logged_in = True
        return True, None

    def logout(self):
        if self.logged_in:
            try:
                self._request("GET", ORIGIN + "/site/logout")
            except UpstreamError:
                pass
        self.jar.clear()
        self.conns.clear()
        self.logged_in = False
        self.hot.clear()
        self.frame_cache.clear()
        self._drop_images()

    def cameras(self):
        payload = self._json("GET", ORIGIN + "/ajax/cameras")
        if not payload or payload.get("error") or not isinstance(payload.get("data"), list):
            self.logged_in = False
            raise AuthError("Session expired. Sign in again.")
        cameras = []
        for item in payload["data"]:
            cameras.append(
                {
                    "id": int(item["id"]),
                    "name": item.get("name") or ("Camera %s" % item["id"]),
                    "motion": bool(item.get("motion_enabled")),
                    "delay": int(item.get("delay_time") or 3000),
                    "noframes": int(item.get("noframes_time") or 6000),
                }
            )
        return cameras

    def server_now(self):
        return time.time() + self.offset

    def range_for(self, camera_id):
        payload = self._json(
            "POST",
            ORIGIN + "/ajax/frame-range",
            {"data[cameras][]": str(camera_id)},
        )
        earliest = None
        if payload and not payload.get("error"):
            raw = (payload.get("data") or {}).get("time")
            if raw:
                earliest = int(raw)
        return {"earliest": earliest, "serverTime": self.server_now()}

    def events_for(self, camera_id, day):
        start, stop = _day_bounds(day)
        payload = self._json(
            "POST",
            ORIGIN + "/ajax/events",
            {"data[start]": str(start), "data[stop]": str(stop)},
        )
        if not payload or payload.get("error"):
            raise UpstreamError("Motion list did not load.")
        events = []
        hours = [0] * 24
        for item in payload.get("data") or []:
            if int(item.get("cam_id") or 0) != camera_id:
                continue
            stamp = int(float(item["time"]))
            hour = datetime.fromtimestamp(stamp, TZ).hour
            hours[hour] += 1
            events.append(
                {
                    "id": str(item.get("id") or stamp),
                    "time": stamp,
                    "hour": hour,
                }
            )
        events.sort(key=lambda event: event["time"])
        return {"day": day, "start": start, "stop": stop, "hours": hours, "events": events}

    def live(self, camera_id):
        started = time.perf_counter()
        hot = self.hot.get(camera_id)
        now = self.server_now()
        probed = []
        best = None

        def consider(server_key):
            nonlocal best
            probed.append(server_key)
            try:
                frame = self._last_frame(server_key, camera_id)
            except UpstreamError as error:
                sys.stderr.write("live %s: %s\n" % (server_key, error))
                return
            if frame is None:
                return
            if best is None or frame["time"] > best["time"]:
                best = frame

        def finish(result):
            result["ms"] = int((time.perf_counter() - started) * 1000)
            result["probed"] = probed
            result["serverTime"] = self.server_now()
            return result

        if hot:
            consider(hot)
            age = None if best is None else now - best["time"]
            probed_recently = time.time() - self.full_probe_at.get(camera_id, 0) < 8
            if best is not None and (age < 4 or probed_recently):
                return finish(best)
            if best is None and probed_recently:
                return finish({"frame": None})

        for server_key in SERVERS:
            if server_key == hot:
                continue
            consider(server_key)
        self.full_probe_at[camera_id] = time.time()
        if best is None:
            return finish({"frame": None})
        self.hot[camera_id] = best["server"]
        return finish(best)

    def frames(self, camera_id, start, stop):
        start = int(start)
        stop = int(stop)
        if stop < start:
            start, stop = stop, start
        if stop - start > MAX_WINDOW:
            stop = start + MAX_WINDOW
        key = (camera_id, start, stop)
        cached = self.frame_cache.get(key)
        if cached and cached["exp"] > time.time():
            self.frame_cache.move_to_end(key)
            return cached["payload"]

        started = time.perf_counter()
        merged = []
        seen = set()
        reached = []
        for server_key in SERVERS:
            try:
                payload = self._json(
                    "POST",
                    SERVERS[server_key] + "/ajax/frames",
                    {
                        "data[camera]": str(camera_id),
                        "data[start]": str(start),
                        "data[stop]": str(stop),
                    },
                )
            except UpstreamError as error:
                sys.stderr.write("frames %s: %s\n" % (server_key, error))
                continue
            reached.append(server_key)
            if not payload or payload.get("error"):
                continue
            for item in payload.get("data") or []:
                frame_id = str(item.get("id") or "")
                if not frame_id.isdigit() or frame_id in seen:
                    continue
                stamp = int(float(item["time"]))
                if stamp < start or stamp > stop:
                    continue
                seen.add(frame_id)
                merged.append(
                    {
                        "id": frame_id,
                        "time": stamp,
                        "server": server_key,
                        "url": "/api/frame/%s/%s.jpg" % (server_key, frame_id),
                    }
                )
        merged.sort(key=lambda frame: (frame["time"], frame["id"]))
        historical = stop < self.server_now() - 180
        payload = {
            "start": start,
            "stop": stop,
            "frames": merged,
            "servers": reached,
            "ms": int((time.perf_counter() - started) * 1000),
        }
        self.frame_cache[key] = {
            "exp": time.time() + (600 if historical else 15),
            "payload": payload,
        }
        while len(self.frame_cache) > 16:
            self.frame_cache.popitem(last=False)
        return payload

    def image(self, server_key, frame_id):
        cache_key = (server_key, frame_id)
        cached = self.image_cache.get(cache_key)
        if cached:
            self.image_cache.move_to_end(cache_key)
            return cached
        status, headers, data = self._request(
            "GET", SERVERS[server_key] + "/%s.jpg" % frame_id
        )
        content_type = _header(headers, "Content-Type") or ""
        if status != 200 or not content_type.startswith("image/") or len(data) > MAX_IMAGE_BYTES:
            raise UpstreamError("Picture %s was not available." % frame_id)
        blob = (content_type.split(";")[0], data)
        self.image_cache[cache_key] = blob
        self.image_bytes += len(data)
        while self.image_bytes > MAX_IMAGE_CACHE and self.image_cache:
            _, (_, old) = self.image_cache.popitem(last=False)
            self.image_bytes -= len(old)
        return blob

    def _last_frame(self, server_key, camera_id):
        payload = self._json(
            "POST",
            SERVERS[server_key] + "/ajax/lastFrame",
            {"data[camera][]": str(camera_id)},
        )
        if not payload or payload.get("error"):
            return None
        data = payload.get("data")
        if not isinstance(data, dict):
            return None
        raw = data.get(str(camera_id))
        if not isinstance(raw, dict) or not raw.get("id"):
            return None
        frame_id = str(raw["id"])
        if not frame_id.isdigit():
            return None
        return {
            "frame": {
                "id": frame_id,
                "time": int(float(raw["time"])),
                "server": server_key,
                "url": "/api/frame/%s/%s.jpg" % (server_key, frame_id),
            },
            "server": server_key,
            "time": int(float(raw["time"])),
        }

    def _refresh_offset(self):
        payload = self._json("GET", ORIGIN + "/ajax/epoch")
        if payload and not payload.get("error") and payload.get("data") is not None:
            self.offset = float(payload["data"]) - time.time()

    def _json(self, method, url, form=None):
        body = None
        headers = {}
        if form is not None:
            body = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        status, _, data = self._request(method, url, body=body, headers=headers)
        if status in (301, 302, 303, 401, 403):
            return None
        try:
            return json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _request(self, method, url, body=None, headers=None, redirects=0, timeout=12):
        if redirects > 5:
            raise UpstreamError("Too many redirects from Inservo.")
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not _allowed_host(parsed.hostname):
            raise UpstreamError("Refused to call %s." % (parsed.hostname or url))
        request_headers = {
            "User-Agent": USER_AGENT,
            "Accept": "*/*",
            "Connection": "keep-alive",
        }
        if headers:
            request_headers.update(headers)
        cookie_request = urllib.request.Request(url)
        self.jar.add_cookie_header(cookie_request)
        cookie = cookie_request.get_header("Cookie")
        if cookie:
            request_headers["Cookie"] = cookie
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        key = parsed.hostname
        last_error = None
        for attempt in (1, 2):
            conn = self._connection(key, timeout)
            try:
                conn.request(method, path, body=body, headers=request_headers)
                response = conn.getresponse()
                data = response.read()
                header_items = response.getheaders()
                break
            except Exception as error:
                last_error = error
                self._drop_conn(key)
                if attempt == 2:
                    raise UpstreamError("Inservo did not answer (%s)." % error) from last_error
        else:
            raise UpstreamError("Inservo did not answer.")
        if len(data) > MAX_IMAGE_BYTES:
            self._drop_conn(key)
            raise UpstreamError("Inservo sent a response that was too large.")
        self._store_cookies(url, header_items)
        status = response.status
        if status in (301, 302, 303, 307, 308):
            location = _header(header_items, "Location")
            if not location:
                raise UpstreamError("Redirect had no destination.")
            next_url = urllib.parse.urljoin(url, location)
            next_method = method
            next_body = body
            if status in (301, 302, 303):
                next_method = "GET"
                next_body = None
            return self._request(next_method, next_url, next_body, headers, redirects + 1, timeout)
        return status, header_items, data

    def _connection(self, host, timeout):
        conn = self.conns.get(host)
        if conn is None:
            conn = http.client.HTTPSConnection(host, timeout=timeout, context=_SSL)
            self.conns[host] = conn
        else:
            conn.timeout = timeout
        return conn

    def _drop_conn(self, host):
        conn = self.conns.pop(host, None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass

    def _store_cookies(self, url, header_items):
        message = HTTPMessage()
        found = False
        for name, value in header_items:
            if name.lower() == "set-cookie":
                message.add_header("Set-Cookie", value)
                found = True
        if not found:
            return

        class _Response:
            def info(self):
                return message

        self.jar.extract_cookies(_Response(), urllib.request.Request(url))

    def _drop_images(self):
        self.image_cache.clear()
        self.image_bytes = 0


def _allowed_host(host):
    if not host:
        return False
    return host == "app.inservo.ee" or host.endswith(".inservo.ee")


def _header(header_items, name):
    for key, value in header_items:
        if key.lower() == name.lower():
            return value
    return None


def _day_bounds(day):
    try:
        year, month, day_num = (int(part) for part in day.split("-"))
        start = datetime(year, month, day_num, tzinfo=TZ)
    except ValueError as error:
        raise UpstreamError("Day must be YYYY-MM-DD.") from error
    stop = start + timedelta(days=1)
    return int(start.timestamp()), int(stop.timestamp())


def _login_message(html):
    blocks = re.findall(r'class="help-block[^"]*"[^>]*>(.*?)</', html, re.S)
    messages = []
    for block in blocks:
        text = re.sub(r"<[^>]+>", "", block)
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            messages.append(text)
    if messages:
        return " ".join(messages)
    if re.search(r'id="login-form"', html):
        return "Email or password was not accepted."
    return None


class SessionStore:
    """One Inservo login per browser. Visitors do not share a feed."""

    def __init__(self):
        self._lock = threading.Lock()
        self._items = {}

    def get(self, token):
        if not token:
            return None
        now = time.time()
        with self._lock:
            self._drop_expired(now)
            item = self._items.get(token)
            if item is None:
                return None
            item["seen"] = now
            return item["client"]

    def create(self):
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            self._drop_expired(now)
            self._items[token] = {"client": Inservo(), "seen": now}
            return token, self._items[token]["client"]

    def delete(self, token):
        if not token:
            return None
        with self._lock:
            item = self._items.pop(token, None)
        if item is None:
            return None
        return item["client"]

    def _drop_expired(self, now):
        expired = [token for token, item in self._items.items() if now - item["seen"] > SESSION_MAX_AGE]
        for token in expired:
            del self._items[token]


SESSIONS = SessionStore()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        self._route("GET")

    def do_HEAD(self):
        self._route("HEAD")

    def do_POST(self):
        self._route("POST")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s  %s\n" % (self.log_date_time_string(), fmt % args))

    def _route(self, method):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if method in ("GET", "HEAD") and path in FILES:
                name, content_type = FILES[path]
                self._file(name, content_type)
                return
            if method == "POST" and path == "/api/login":
                self._login()
                return
            if method == "POST" and path == "/api/logout":
                self._logout()
                return
            if method == "GET" and path == "/api/me":
                self._me()
                return
            if method == "GET" and path == "/api/range":
                self._range(query)
                return
            if method == "GET" and path == "/api/events":
                self._events(query)
                return
            if method == "GET" and path == "/api/live":
                self._live(query)
                return
            if method == "GET" and path == "/api/frames":
                self._frames(query)
                return
            image = re.fullmatch(r"/api/frame/(s[345])/([0-9]+)\.jpg", path)
            if method == "GET" and image:
                self._image(image.group(1), image.group(2))
                return
            self._send_json(404, {"ok": False, "error": "Not found."})
        except AuthError as error:
            self._send_json(401, {"ok": False, "error": str(error)})
        except UpstreamError as error:
            self._send_json(502, {"ok": False, "error": str(error)})
        except Exception as error:
            sys.stderr.write("handler error: %s\n" % error)
            self._send_json(500, {"ok": False, "error": "Local client failed."})

    def _login(self):
        raw = self._body()
        try:
            payload = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            self._send_json(400, {"ok": False, "error": "Login request was not valid."})
            return
        username = str(payload.get("username") or "").strip()
        password = str(payload.get("password") or "")
        if not username or not password:
            self._send_json(400, {"ok": False, "error": "Enter both email and password."})
            return
        token = self._session_token()
        client = SESSIONS.get(token)
        fresh = client is None
        if fresh:
            token, client = SESSIONS.create()
        try:
            with client.lock:
                ok, message = client.login(username, password)
                cameras = client.cameras() if ok else []
                server_time = client.server_now() if ok else None
        except Exception:
            if fresh:
                SESSIONS.delete(token)
            raise
        if not ok:
            if fresh:
                SESSIONS.delete(token)
            self._send_json(401, {"ok": False, "error": message})
            return
        self._send_json(200, {"ok": True, "cameras": cameras, "serverTime": server_time}, session=token)

    def _logout(self):
        token = self._session_token()
        client = SESSIONS.delete(token)
        if client is not None:
            with client.lock:
                client.logout()
        self._send_json(200, {"ok": True}, clear_session=True)

    def _me(self):
        client = SESSIONS.get(self._session_token())
        if client is None:
            self._send_json(200, {"ok": False})
            return
        with client.lock:
            signed_in = client.logged_in
            cameras = client.cameras() if signed_in else []
            server_time = client.server_now() if signed_in else None
        if not signed_in:
            self._send_json(200, {"ok": False})
            return
        self._send_json(200, {"ok": True, "cameras": cameras, "serverTime": server_time})

    def _range(self, query):
        camera_id = _camera(query)
        client = self._client()
        with client.lock:
            self._require(client)
            payload = client.range_for(camera_id)
        self._send_json(200, {"ok": True, **payload})

    def _events(self, query):
        camera_id = _camera(query)
        day = (query.get("day") or [""])[0]
        client = self._client()
        with client.lock:
            self._require(client)
            payload = client.events_for(camera_id, day)
        self._send_json(200, {"ok": True, **payload})

    def _live(self, query):
        camera_id = _camera(query)
        client = self._client()
        with client.lock:
            self._require(client)
            payload = client.live(camera_id)
        self._send_json(
            200,
            {
                "ok": True,
                "frame": payload.get("frame"),
                "server": payload.get("server"),
                "probed": payload.get("probed") or [],
                "ms": payload.get("ms") or 0,
                "serverTime": payload.get("serverTime"),
            },
        )
        sys.stderr.write(
            "live camera=%s probed=%s %sms\n"
            % (camera_id, ",".join(payload.get("probed") or []), payload.get("ms"))
        )

    def _frames(self, query):
        camera_id = _camera(query)
        try:
            start = int((query.get("start") or [""])[0])
            stop = int((query.get("stop") or [""])[0])
        except ValueError:
            self._send_json(400, {"ok": False, "error": "Start and stop must be unix times."})
            return
        client = self._client()
        with client.lock:
            self._require(client)
            payload = client.frames(camera_id, start, stop)
        self._send_json(200, {"ok": True, **payload})
        sys.stderr.write(
            "frames camera=%s %s-%s count=%s servers=%s %sms\n"
            % (
                camera_id,
                payload["start"],
                payload["stop"],
                len(payload["frames"]),
                ",".join(payload["servers"]),
                payload["ms"],
            )
        )

    def _image(self, server_key, frame_id):
        started = time.perf_counter()
        client = self._client()
        with client.lock:
            self._require(client)
            content_type, data = client.image(server_key, frame_id)
        self._send_bytes(
            200,
            data,
            content_type,
            {"Cache-Control": "private, max-age=86400"},
        )
        sys.stderr.write(
            "image %s/%s %skb %sms\n"
            % (server_key, frame_id, max(1, len(data) // 1024), int((time.perf_counter() - started) * 1000))
        )

    def _client(self):
        client = SESSIONS.get(self._session_token())
        if client is None:
            raise AuthError("Sign in first.")
        return client

    def _require(self, client):
        if not client.logged_in:
            raise AuthError("Session ended. Sign in again.")

    def _session_token(self):
        header = self.headers.get("Cookie")
        if not header:
            return None
        for part in header.split(";"):
            name, separator, value = part.strip().partition("=")
            if separator and name == SESSION_COOKIE and value:
                return value
        return None

    def _https(self):
        forwarded = self.headers.get("X-Forwarded-Proto") or ""
        return forwarded.split(",")[0].strip().lower() == "https"

    def _session_cookie(self, token, clear=False):
        parts = [
            "%s=%s" % (SESSION_COOKIE, "" if clear else token),
            "HttpOnly",
            "Path=/",
            "SameSite=Lax",
            "Max-Age=%d" % (0 if clear else SESSION_MAX_AGE),
        ]
        if self._https():
            parts.append("Secure")
        return "; ".join(parts)

    def _body(self):
        length = int(self.headers.get("Content-Length") or "0")
        if length < 0 or length > 16000:
            raise UpstreamError("Request body is too large.")
        return self.rfile.read(length)

    def _file(self, name, content_type):
        file_path = STATIC / name
        if not file_path.is_file():
            self._send_json(404, {"ok": False, "error": "Missing %s." % name})
            return
        data = file_path.read_bytes()
        self._send_bytes(200, data, content_type, {"Cache-Control": "no-store"})

    def _send_json(self, status, payload, session=None, clear_session=False):
        data = json.dumps(payload).encode()
        cookies = []
        if clear_session:
            cookies.append(self._session_cookie("", clear=True))
        elif session:
            cookies.append(self._session_cookie(session))
        self._send_bytes(
            status,
            data,
            "application/json; charset=utf-8",
            {"Cache-Control": "no-store"},
            cookies,
        )

    def _send_bytes(self, status, data, content_type, extra=None, cookies=None):
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Content-Type-Options", "nosniff")
            cache = "no-store"
            if extra and "Cache-Control" in extra:
                cache = extra["Cache-Control"]
            self.send_header("Cache-Control", cache)
            if extra:
                for key, value in extra.items():
                    if key == "Cache-Control":
                        continue
                    self.send_header(key, value)
            for cookie in cookies or []:
                self.send_header("Set-Cookie", cookie)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


def _camera(query):
    raw = (query.get("camera") or [""])[0]
    if not str(raw).isdigit():
        raise UpstreamError("Missing camera.")
    return int(raw)


def main():
    port = 8765
    if len(sys.argv) == 2:
        port = int(sys.argv[1])
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print("Inservo client at http://127.0.0.1:%s" % port, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
