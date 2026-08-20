import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

Item {
    id: full

    // `root` is the PlasmoidItem (id: root in main.qml); Plasma injects it as
    // an implicit context property when loading a representation.
    readonly property var backend: root.backend

    Layout.minimumWidth: Kirigami.Units.gridUnit * 20
    Layout.minimumHeight: Kirigami.Units.gridUnit * 24
    Layout.preferredWidth: Kirigami.Units.gridUnit * 24
    Layout.preferredHeight: Kirigami.Units.gridUnit * 28

    ColumnLayout {
        anchors.fill: parent
        spacing: 0
        // Nothing secret is even rendered while the widget is hidden. The
        // opaque scrim above is the guarantee, but not drawing the panel at
        // all is both the stronger privacy answer and the cheaper one: a
        // message arriving while hidden no longer repaints a chat list nobody
        // can see. An invisible item also takes no input, so there is no
        // click-through into a "hidden" panel.
        visible: !root.hidden

        RowLayout {
            Layout.fillWidth: true
            Layout.margins: Kirigami.Units.smallSpacing

            PlasmaComponents.Label {
                Layout.fillWidth: true
                text: i18n("WhatsApp")
            }

            PlasmaComponents.ToolButton {
                icon.name: "view-hidden"
                display: PlasmaComponents.AbstractButton.IconOnly
                text: i18n("Hide")
                visible: !root.hidden
                onClicked: root.hide()
            }
        }

        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            PairingView {
                anchors.centerIn: parent
                width: parent.width - Kirigami.Units.gridUnit * 2
                backend: full.backend
                visible: full.backend.status === "needs-pairing"
                // Fetching the code costs a loopback request, so only do it
                // while the popup is actually open on a backend that wants
                // pairing.
                active: visible && root.expanded
            }

            PlasmaComponents.Label {
                anchors.centerIn: parent
                visible: full.backend.status !== "needs-pairing" && full.backend.status !== "connected"
                text: i18n("Connecting…")
            }

            ChatPanel {
                anchors.fill: parent
                anchors.margins: Kirigami.Units.smallSpacing
                backend: full.backend
                visible: full.backend.status === "connected"
            }
        }
    }

    // One mechanism, one call site's worth of state: `passwordRequired` is
    // assigned here and nowhere else, and is never bound to anything. A
    // binding on top of these writes would break on the first write and then
    // report whatever the gate happened to say the last time it evaluated.
    function refreshGate() {
        hideOverlay.passwordRequired = root.passwordRequired();
        // The gate may have just swapped the Reveal button for the password
        // field under an overlay that is already on screen, which moves no
        // focus by itself.
        hideOverlay.focusPrompt();
    }

    // A popup that closes and reopens does not necessarily toggle the
    // overlay item's `visible`, so re-check on expansion too. Same imperative
    // assignment; no second mechanism, and still nothing that ticks.
    Connections {
        target: root

        function onExpandedChanged() {
            if (root.expanded && root.hidden) full.refreshGate();
        }
    }

    // The full representation is created lazily, so it can come into being
    // with the widget already hidden — in which case `visible` starts out true
    // and never changes, and onShown never fires.
    Component.onCompleted: if (root.hidden) full.refreshGate();

    HideOverlay {
        id: hideOverlay
        anchors.fill: parent
        visible: root.hidden

        onShown: full.refreshGate()

        onRevealRequested: {
            // reveal() re-tests the threshold itself and refuses once it has
            // passed, so an overlay that has been sitting on screen since
            // before the deadline cannot be revealed from a stale decision.
            if (!root.reveal()) full.refreshGate();
        }

        onUnlockRequested: function (password) {
            // The hide this attempt belongs to. A reply that lands after the
            // user hid again must not un-hide the new one.
            const session = root.hiddenSince;
            // `password` goes into the request body and no further: it is not
            // stored, logged, or written to any property that outlives the
            // call.
            full.backend.unlock(password, function (err, data) {
                if (!err) {
                    hideOverlay.reset();
                    if (root.hidden && root.hiddenSince === session) root.revealUnlocked();
                    return;
                }
                // Everything below stays hidden. No branch here reveals, and
                // none of them retries — the backend's backoff is the whole
                // brute-force defence and must not be worked around.
                if (err === 429 || (data && data.reason === "throttled")) {
                    const seconds = (data && data.retryAfterMs > 0)
                        ? Math.ceil(data.retryAfterMs / 1000) : 0;
                    hideOverlay.failed(seconds > 0
                        ? i18nc("@info", "Too many attempts. Try again in %1s.", seconds)
                        : i18nc("@info", "Too many attempts. Try again shortly."));
                } else if (data && data.reason === "invalid") {
                    hideOverlay.failed(i18nc("@info", "Incorrect password."));
                } else {
                    // Backend unreachable, request timed out, refused for some
                    // other reason: the password was never verified, so it is
                    // not an unlock.
                    hideOverlay.failed(i18nc("@info", "Could not verify the password."));
                }
            });
        }
    }
}
