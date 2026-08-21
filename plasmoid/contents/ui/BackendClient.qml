import QtQuick
import QtCore as QtCore
import QtWebSockets
import org.kde.plasma.plasma5support as P5Support

import "../code/backend.js" as Backend

/**
 * Live client for the loopback backend.
 *
 * Everything it needs — port and bearer token — comes from the 0600 endpoint
 * file the backend writes into $XDG_RUNTIME_DIR. There is no polling: live
 * updates arrive as pushes over the /events WebSocket, and the endpoint file
 * is re-read only when a connection attempt has actually failed.
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

    // Reconnect backoff. Every retry forks a `cat` to re-read the endpoint
    // file, and "backend not running" is the widget's default state until the
    // user enables the systemd unit — a flat 5s retry would be ~720 process
    // spawns an hour on battery. Doubles per consecutive failure, capped, and
    // reset the moment the event socket opens.
    readonly property int reconnectMinDelay: 5000
    readonly property int reconnectMaxDelay: 60000
    property int reconnectDelay: reconnectMinDelay

    // Measured against Qt 6.11: setting `active = false` emits no status
    // change at all, and the only synchronous transition the reopen produces
    // is `Connecting`, which onStatusChanged ignores. So this guard is
    // currently vacuous — it is kept as cheap insurance in case a future Qt
    // does emit `Closed` synchronously, which would otherwise read as a
    // dropped connection and turn reconnection into a poll.
    property bool restartingSocket: false

    // connectSource() on an already-connected source is a no-op, so a second
    // read while one is still in flight would be silently dropped.
    property bool readingEndpoint: false

    // QML's XMLHttpRequest does not implement timeouts — measured on Qt 6.11:
    // `xhr.timeout` is settable but never fires and `ontimeout` is not even a
    // member of the object. A backend that accepts the TCP connection and then
    // never answers would hang the callback forever, so every in-flight
    // request carries its own one-shot guard timer instead.
    readonly property int requestTimeout: 10000
    readonly property Component requestGuard: Component {
        Timer { repeat: false }
    }

    function scheduleReconnect() {
        // One outage produces several failure signals — the socket closing and
        // every in-flight request failing with it. The timer is one-shot, so
        // `running` is true exactly while a retry is already pending; collapse
        // them all into that one retry instead of advancing the backoff once
        // per signal (which would make the first retry 10s, not 5s).
        if (client.reconnectTimer.running) return;
        client.reconnectTimer.interval = client.reconnectDelay;
        client.reconnectTimer.restart();
        client.reconnectDelay = Math.min(client.reconnectDelay * 2, client.reconnectMaxDelay);
    }

    function markDisconnected() {
        // Nothing known about the backend is trustworthy any more. Leaving
        // `unread`/`chats` behind would render a stale badge and a stale chat
        // list against a backend that is gone.
        client.status = "disconnected";
        client.unread = 0;
        client.chats = [];
        // This connection is no longer a candidate for proving itself, so it
        // must not go on to reset the backoff behind our back.
        client.stabilityTimer.stop();
    }

    function loadEndpoint() {
        if (readingEndpoint || endpointFile === "") {
            // Nothing was started, so nothing will call back. Without this the
            // widget would hang silently and never retry again.
            scheduleReconnect();
            return;
        }
        readingEndpoint = true;
        endpointReader.connectSource(Backend.readCommand(endpointFile));
    }

    function applyEndpoint(next) {
        if (!next) {
            // No readable endpoint file: the backend is down or not up yet.
            client.endpoint = null;
            markDisconnected();
            scheduleReconnect();
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

    // callback(errorOrNull, parsedBodyOrNull). `error` is an HTTP status code
    // for a reachable backend that refused the request, or the string
    // "unreachable"/"no backend" when the request never got an answer.
    function request(method, path, body, callback) {
        if (!endpoint) {
            if (callback) callback("no backend", null);
            return;
        }

        var xhr = new XMLHttpRequest();
        var guard = null;
        var settled = false;

        function finish(err, data) {
            if (settled) return;
            settled = true;
            if (guard) {
                guard.stop();
                guard.destroy();
                guard = null;
            }
            if (callback) callback(err, data);
        }

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
                finish(null, parsed);
            } else {
                // status 0 means the request never reached the backend.
                finish(xhr.status || "unreachable", parsed);
            }
        };
        // Created last, once nothing above can still throw: a guard built
        // before xhr.open()/setRequestHeader() would be orphaned by a throw —
        // never started, never destroyed, and the callback never fired.
        guard = client.requestGuard.createObject(client, { interval: client.requestTimeout });
        guard.triggered.connect(function () {
            // Connection accepted but no answer: give up rather than hang.
            xhr.abort();
            finish("unreachable", null);
        });
        guard.start();
        xhr.send(body ? JSON.stringify(body) : null);
    }

    function refreshStatus() {
        request("GET", "/status", null, function (err, data) {
            if (Backend.isTransportError(err)) {
                // The backend is unreachable. Arm a retry as well: the event
                // socket may still look Open, in which case nothing else would
                // ever re-query and the dot would stay red forever.
                client.markDisconnected();
                client.scheduleReconnect();
                return;
            }
            // An HTTP error status means the backend answered — it is up. Do
            // not claim "disconnected" on the strength of one refused request.
            if (err || !data) return;
            client.status = data.status;
            client.unread = data.unread;
        });
    }

    function refreshChats() {
        request("GET", "/chats", null, function (err, data) {
            if (Backend.isTransportError(err)) {
                // The `message` event path calls this on its own, so without
                // this branch a transport failure there would leave `chats`
                // stale with no retry armed.
                client.markDisconnected();
                client.scheduleReconnect();
                return;
            }
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

    /**
     * Remove a chat from this widget's list, or put it back.
     *
     * Local to the widget: nothing is sent to WhatsApp, and the conversation
     * is untouched on the phone and every other linked device.
     */
    function setChatHidden(jid, hidden) {
        request("POST", "/chats/" + encodeURIComponent(jid) + "/hidden",
                { hidden: hidden }, function (err) {
            // On failure the list is already correct, since it still reflects
            // the backend. The push that follows a success refreshes it.
            if (err) return;
            client.refreshStatus();
            client.refreshChats();
        });
    }

    function markRead(jid) {
        request("POST", "/chats/" + encodeURIComponent(jid) + "/read", {}, function (err) {
            // The mark did not happen, so there is no new unread count to go
            // and fetch. Acting on a failed write would only mislead.
            if (err) return;
            client.refreshStatus();
            // refreshStatus() only refreshes the *total* unread count; the
            // per-chat counts inside `chats` still hold their pre-read value
            // without this, so the chat list would keep showing a badge on a
            // chat that was just read.
            client.refreshChats();
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
            } else if (event.type === "chats") {
                // History sync, an archive toggle, or a name arriving from the
                // contact/group lists. The backend already coalesces these, so
                // this is one refetch per burst rather than one per chat.
                client.unread = event.unread;
                client.refreshChats();
            }
        }

        onStatusChanged: {
            if (client.socket.status === WebSocket.Open) {
                client.reconnectTimer.stop();
                // Deliberately NOT resetting the backoff here. A backend that
                // upgrades the socket and then drops it immediately would
                // otherwise pin the ladder at 5s forever — the exact flat
                // retry the backoff exists to prevent, in the state where it
                // costs most. The reset waits for stabilityTimer.
                client.stabilityTimer.restart();
                return;
            }
            if (client.restartingSocket) return;
            if (client.socket.status === WebSocket.Error || client.socket.status === WebSocket.Closed) {
                // The backend is gone: stop reporting the last known good
                // state, or a dead backend keeps rendering a green dot.
                client.markDisconnected();
                // One-shot retry on failure only. This is not a poll: it is
                // armed by a drop, backs off, and is stopped again the moment
                // we reconnect.
                client.scheduleReconnect();
            }
        }
    }

    property Timer reconnectTimer: Timer {
        interval: client.reconnectMinDelay
        repeat: false
        onTriggered: client.loadEndpoint()
    }

    // Resets the backoff once a connection has proven itself by staying Open
    // for a full reconnectMinDelay. Armed on Open, stopped on any close, so a
    // flapping backend never reaches the reset and keeps climbing the ladder,
    // while a genuinely healthy connection is back to a 5s retry within five
    // seconds of connecting and cannot be left pinned at the 60s cap.
    //
    // Time, not a successful /status, is the test on purpose: the crash-loop
    // this guards against accepts the WebSocket upgrade, so it is serving HTTP
    // too and would answer /status happily on every iteration of the loop.
    property Timer stabilityTimer: Timer {
        interval: client.reconnectMinDelay
        repeat: false
        onTriggered: client.reconnectDelay = client.reconnectMinDelay
    }

    Component.onCompleted: loadEndpoint()
}
