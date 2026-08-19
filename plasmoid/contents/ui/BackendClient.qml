import QtQuick
import QtCore as QtCore
import QtWebSockets
import org.kde.plasma.plasma5support as P5Support

import "../code/backend.js" as Backend

/**
 * Live client for the loopback backend.
 *
 * Everything it needs — port and bearer token — comes from the 0600 endpoint
 * file the backend writes into $XDG_RUNTIME_DIR. Reads happen exactly twice
 * per connection attempt path: once at startup, and once per one-shot
 * reconnect after the event socket drops. There is no polling anywhere; live
 * updates arrive as pushes over the /events WebSocket.
 */
QtObject {
    id: client

    // {port, token} once the endpoint file has been read, null otherwise.
    property var endpoint: null
    property string status: "disconnected"
    property int unread: 0
    property var chats: []
    readonly property bool connected: endpoint !== null && status === "connected"

    signal messageReceived(string jid, var message)

    readonly property string endpointFile: Backend.endpointPath(
        QtCore.StandardPaths.writableLocation(QtCore.StandardPaths.RuntimeLocation))

    // Guards the deliberate close/reopen inside applyEndpoint() so that the
    // resulting WebSocket.Closed does not look like a dropped connection and
    // arm the reconnect timer — that would turn reconnection into a 5s poll.
    property bool restartingSocket: false

    // connectSource() on an already-connected source is a no-op, so a second
    // read while one is still in flight would be silently dropped.
    property bool readingEndpoint: false

    function loadEndpoint() {
        if (readingEndpoint || endpointFile === "") return;
        readingEndpoint = true;
        endpointReader.connectSource(Backend.readCommand(endpointFile));
    }

    function applyEndpoint(next) {
        if (!next) {
            // No readable endpoint file: the backend is down or not up yet.
            client.endpoint = null;
            client.status = "disconnected";
            client.reconnectTimer.restart();
            return;
        }

        client.endpoint = next;
        client.restartingSocket = true;
        // Assigning `url` while `active` is already true does not re-dial, so
        // a reconnect after the first drop would silently do nothing. Force
        // the socket down, then back up.
        client.socket.active = false;
        client.socket.url = Backend.eventsUrl(next);
        client.socket.active = true;
        client.restartingSocket = false;

        refreshStatus();
        refreshChats();
    }

    // callback(errorOrNull, parsedBodyOrNull)
    function request(method, path, body, callback) {
        if (!endpoint) {
            if (callback) callback("no backend", null);
            return;
        }
        var xhr = new XMLHttpRequest();
        xhr.open(method, Backend.buildUrl(endpoint, path));
        xhr.setRequestHeader("Authorization", "Bearer " + endpoint.token);
        if (body) xhr.setRequestHeader("Content-Type", "application/json");
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            var parsed = null;
            if (xhr.responseText) {
                try {
                    parsed = JSON.parse(xhr.responseText);
                } catch (e) {
                    parsed = null;
                }
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                if (callback) callback(null, parsed);
            } else if (callback) {
                // status 0 means the request never reached the backend.
                callback(xhr.status || "unreachable", parsed);
            }
        };
        xhr.send(body ? JSON.stringify(body) : null);
    }

    function refreshStatus() {
        request("GET", "/status", null, function (err, data) {
            if (err || !data) {
                client.status = "disconnected";
                return;
            }
            client.status = data.status;
            client.unread = data.unread;
        });
    }

    function refreshChats() {
        request("GET", "/chats", null, function (err, data) {
            if (!err && data) client.chats = data.chats;
        });
    }

    function loadMessages(jid, callback) {
        request("GET", "/chats/" + encodeURIComponent(jid) + "/messages", null, function (err, data) {
            if (callback) callback(err, data ? data.messages : []);
        });
    }

    function send(jid, text, callback) {
        request("POST", "/chats/" + encodeURIComponent(jid) + "/messages", { text: text }, callback);
    }

    function markRead(jid) {
        request("POST", "/chats/" + encodeURIComponent(jid) + "/read", {}, function () {
            refreshStatus();
        });
    }

    function unlock(password, callback) {
        request("POST", "/unlock", { password: password }, callback);
    }

    // Reads the endpoint file. QML's XMLHttpRequest cannot open file:// URLs
    // unless the host process sets QML_XHR_ALLOW_FILE_READ=1, and plasmashell
    // does not, so this goes through Plasma's "executable" data engine. It
    // runs once per connectSource() and is disconnected again as soon as the
    // output arrives — not a periodic source.
    property P5Support.DataSource endpointReader: P5Support.DataSource {
        engine: "executable"
        connectedSources: []

        onNewData: function (sourceName, data) {
            disconnectSource(sourceName);
            client.readingEndpoint = false;
            client.applyEndpoint(Backend.parseEndpoint((data["stdout"] || "").toString()));
        }
    }

    property WebSocket socket: WebSocket {
        active: false

        onTextMessageReceived: function (message) {
            var event = null;
            try {
                event = JSON.parse(message);
            } catch (e) {
                return;
            }
            if (!event) return;

            if (event.type === "status") {
                client.status = event.status;
                if (event.status === "connected") client.refreshChats();
            } else if (event.type === "unread") {
                client.unread = event.unread;
            } else if (event.type === "message") {
                client.unread = event.unread;
                client.refreshChats();
                client.messageReceived(event.jid, event.message);
            }
        }

        onStatusChanged: {
            if (client.socket.status === WebSocket.Open) {
                client.reconnectTimer.stop();
                return;
            }
            if (client.restartingSocket) return;
            if (client.socket.status === WebSocket.Error || client.socket.status === WebSocket.Closed) {
                // The backend is gone: stop reporting the last known good
                // state, or a dead backend keeps rendering a green dot.
                client.status = "disconnected";
                // One-shot retry on failure only. This is not a poll: it is
                // armed by a drop and stopped again the moment we reconnect.
                client.reconnectTimer.restart();
            }
        }
    }

    property Timer reconnectTimer: Timer {
        interval: 5000
        repeat: false
        onTriggered: client.loadEndpoint()
    }

    Component.onCompleted: loadEndpoint()
}
