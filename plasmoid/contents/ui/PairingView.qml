import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

/**
 * Pairing screen: renders the QR code the backend produces for WhatsApp's
 * "Linked Devices" flow.
 *
 * The image cannot be pointed straight at the backend's /qr route. Every HTTP
 * route requires an `Authorization: Bearer` header (backend/src/server.js,
 * `authorized()`), the token-as-query-parameter concession exists for the
 * WebSocket upgrade only, and `Image` cannot set request headers. Measured
 * against the live backend: GET /qr with no auth -> 401, with ?token=<valid>
 * -> 401, with the bearer header -> 200. So the PNG is fetched with an
 * XMLHttpRequest that can set the header and handed to `Image` as a data URI.
 */
ColumnLayout {
    id: pairing

    required property var backend

    // True only while this view is really on screen (popup open *and* the
    // backend still wants pairing). Gates the refresh below.
    property bool active: false

    // Set once a code has actually been fetched; drives the placeholder.
    readonly property bool hasCode: String(qrImage.source).length > 0

    spacing: Kirigami.Units.largeSpacing

    // The in-flight QR request, so a new attempt can cancel a stalled one.
    // QML's XMLHttpRequest has no working timeout (see BackendClient), so an
    // accepted-but-unanswered request would otherwise hang forever.
    property var pendingRequest: null

    // Base64 of an ArrayBuffer. Qt.btoa() is not usable here: it UTF-8 encodes
    // its argument before encoding, which corrupts every byte above 0x7f — and
    // a PNG is full of them.
    function encodeBase64(buffer) {
        var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        var bytes = new Uint8Array(buffer);
        var out = "";
        for (var i = 0; i < bytes.length; i += 3) {
            var b0 = bytes[i];
            var b1 = bytes[i + 1];
            var b2 = bytes[i + 2];
            out += alphabet[b0 >> 2];
            out += alphabet[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
            out += b1 === undefined ? "=" : alphabet[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
            out += b2 === undefined ? "=" : alphabet[b2 & 0x3f];
        }
        return out;
    }

    function refreshQr() {
        var endpoint = pairing.backend.endpoint;
        if (!endpoint) {
            qrImage.source = "";
            return;
        }

        if (pairing.pendingRequest) {
            // Drop the reference first: abort() runs the handler below
            // synchronously, and it must recognise itself as superseded
            // rather than clear a QR that is still perfectly good.
            var stalled = pairing.pendingRequest;
            pairing.pendingRequest = null;
            stalled.abort();
        }

        var xhr = new XMLHttpRequest();
        pairing.pendingRequest = xhr;
        xhr.open("GET", "http://127.0.0.1:" + endpoint.port + "/qr");
        xhr.setRequestHeader("Authorization", "Bearer " + endpoint.token);
        xhr.responseType = "arraybuffer";
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== XMLHttpRequest.DONE) return;
            // A request that is no longer the pending one was superseded; its
            // result, or its abort, says nothing about what should be shown.
            if (pairing.pendingRequest !== xhr) return;
            pairing.pendingRequest = null;
            if (xhr.status !== 200 || !xhr.response) {
                // 404 means the backend has no code yet; anything else means it
                // could not answer. Either way there is nothing to show.
                qrImage.source = "";
                return;
            }
            // Assigning the same string is a no-op in QML, so an unchanged code
            // does not make the image flicker.
            qrImage.source = "data:image/png;base64," + pairing.encodeBase64(xhr.response);
        };
        xhr.send();
    }

    PlasmaComponents.Label {
        Layout.fillWidth: true
        horizontalAlignment: Text.AlignHCenter
        wrapMode: Text.WordWrap
        text: i18n("Scan with WhatsApp → Linked Devices")
    }

    Item {
        Layout.alignment: Qt.AlignHCenter
        Layout.preferredWidth: Kirigami.Units.gridUnit * 14
        Layout.preferredHeight: Kirigami.Units.gridUnit * 14

        Image {
            id: qrImage
            anchors.fill: parent
            fillMode: Image.PreserveAspectFit
            cache: false
            visible: pairing.hasCode
        }

        PlasmaComponents.Label {
            anchors.centerIn: parent
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            visible: !pairing.hasCode
            text: i18n("Waiting for a pairing code…")
        }
    }

    // WhatsApp rotates the pairing code every few tens of seconds and the
    // backend only emits a `status` event on an actual status *change*, so a
    // rotated code arrives over no push channel at all — a code fetched once
    // would silently expire while the user is still reaching for their phone.
    // This is deliberately not an idle-cost poll: it runs only while the popup
    // is open *and* the backend is asking to be paired, i.e. for the few
    // seconds of a one-off pairing flow, and stops the moment either ends.
    Timer {
        interval: 20000
        repeat: true
        triggeredOnStart: true
        running: pairing.active
        onTriggered: pairing.refreshQr()
    }
}
