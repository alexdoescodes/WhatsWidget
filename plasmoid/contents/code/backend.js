.pragma library

// Pure helpers for talking to the loopback backend. Kept free of QML types so
// they can be reasoned about (and reused) without instantiating a component.

var ENDPOINT_FILE = "whatsapp-widget-endpoint.json";

// StandardPaths.writableLocation() hands back a QUrl, which stringifies to
// "file:///run/user/1000" — verified on this system. Strip the scheme so the
// result is a plain filesystem path that a shell command can consume.
function endpointPath(runtimeDirUrl) {
    var dir = String(runtimeDirUrl).replace(/^file:\/\//, "").replace(/\/+$/, "");
    if (!dir) return "";
    return dir + "/" + ENDPOINT_FILE;
}

// QML's XMLHttpRequest refuses file:// URLs unless the host process was
// started with QML_XHR_ALLOW_FILE_READ=1, and plasmashell is not (confirmed
// by reading /proc/<plasmashell>/environ). The endpoint file therefore has to
// be read through Plasma's "executable" data engine, which runs the command
// through a shell — so the path is single-quoted here rather than pasted in
// raw. The token itself never appears in the command line, only in stdout.
function readCommand(path) {
    return "cat '" + String(path).replace(/'/g, "'\\''") + "'";
}

// Returns {port, token} or null. Anything malformed, truncated or missing a
// field is treated as "no backend" rather than half-trusted.
function parseEndpoint(text) {
    if (!text) return null;
    try {
        var parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") return null;
        var port = Number(parsed.port);
        if (!(port > 0 && port < 65536)) return null;
        if (typeof parsed.token !== "string" || parsed.token.length === 0) return null;
        return { port: port, token: parsed.token };
    } catch (e) {
        return null;
    }
}

// True when a request never reached the backend at all, as opposed to being
// answered and refused. Only the former justifies declaring the backend down:
// an HTTP error status proves the backend is up and talking.
function isTransportError(err) {
    return err === "unreachable" || err === "no backend";
}

function buildUrl(endpoint, path) {
    return "http://127.0.0.1:" + endpoint.port + path;
}

// The upgrade handshake carries the token as a query parameter because QML's
// WebSocket type cannot set request headers; the backend accepts that on this
// one route only (see authorizedUpgrade in backend/src/server.js).
function eventsUrl(endpoint) {
    return "ws://127.0.0.1:" + endpoint.port + "/events?token=" + encodeURIComponent(endpoint.token);
}
