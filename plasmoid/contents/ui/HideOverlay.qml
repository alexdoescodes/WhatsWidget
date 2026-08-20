import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

/**
 * Censors the panel while the widget is hidden, and hosts the password prompt
 * once the hide has outlived the configured threshold.
 *
 * Occlusion is one fully opaque Rectangle and nothing else. Task 13 measured
 * MultiEffect's blur on this system (Plasma 6.7.2 / Qt 6.11, software-offscreen
 * and real GPU-composited Wayland alike) as inconsistent — anywhere from a
 * no-op to a soft halo that still left chat names readable — so privacy never
 * rested on it. Sitting under an opaque scrim it did no privacy work at all
 * while still holding a live source that re-rendered (and re-blurred) every
 * time a message arrived behind the scrim, which is pure battery cost on a
 * laptop in the state the user picked for discretion. It is gone; the
 * Rectangle is the whole guarantee.
 *
 * That Rectangle follows the colour scheme but forces alpha to 1.0.
 * Kirigami.Theme.backgroundColor is not guaranteed opaque — a theme may carry
 * alpha in that role — and an "opaque" scrim that is quietly translucent leaks
 * exactly the message content this exists to hide. Matching the theme is a
 * preference; occluding is a requirement, so it must not be a theme setting.
 */
Item {
    id: overlay

    // Whether revealing currently needs the login password. Assigned
    // imperatively by the owner (see FullRepresentation) and never bound to
    // anything: a declarative binding plus an imperative write would break the
    // binding on the first write and leave the gate evaluating stale — which,
    // in the direction that matters, means offering "Reveal" when a password
    // is due. This drives the UI only; the authoritative check lives in
    // main.qml's reveal(), which re-tests the threshold on every attempt.
    property bool passwordRequired: false
    property bool busy: false
    property string errorText: ""

    signal revealRequested()
    signal unlockRequested(string password)
    // Emitted when the overlay comes on screen, so the owner can refresh the
    // gate without attaching its own onVisibleChanged to this object. (Qt 6.11
    // does run both a component's own handler and one added at the
    // instantiation site — measured, not assumed — so that would work too. It
    // would just leave the clearing of the typed password on the same signal
    // an outside file is free to redeclare, and this component's one security
    // duty should not be that easy to displace by accident.)
    signal shown()

    function submit(password) {
        if (overlay.busy || password.length === 0) return;
        overlay.busy = true;
        overlay.errorText = "";
        // The only place the typed password goes: straight out to the owner,
        // which puts it in the /unlock request body and nowhere else.
        overlay.unlockRequested(password);
    }

    // The attempt was refused, or never got an answer. Reveals nothing by
    // construction, and drops the typed password immediately.
    function failed(message) {
        overlay.busy = false;
        overlay.errorText = message;
        passwordField.text = "";
        if (overlay.visible && overlay.passwordRequired) passwordField.forceActiveFocus();
    }

    // Drops any typed password and clears transient state.
    function reset() {
        passwordField.text = "";
        overlay.busy = false;
        overlay.errorText = "";
    }

    onVisibleChanged: {
        if (!overlay.visible) {
            // Covers the popup closing as well as the panel being revealed, so
            // a half-typed password never outlives the prompt.
            overlay.reset();
            return;
        }
        // Synchronous: the handler re-evaluates passwordRequired before the
        // focus decision below reads it.
        overlay.shown();
        // Pull focus off whatever had it underneath — the composer, typically —
        // so keystrokes cannot reach the censored panel while it is hidden.
        if (overlay.passwordRequired) passwordField.forceActiveFocus();
        else revealButton.forceActiveFocus();
    }

    Rectangle {
        anchors.fill: parent
        // Theme colour with alpha pinned to 1.0 — see the note above.
        color: Qt.rgba(Kirigami.Theme.backgroundColor.r,
                       Kirigami.Theme.backgroundColor.g,
                       Kirigami.Theme.backgroundColor.b,
                       1.0)
    }

    // Swallows clicks, wheels and hovers that would otherwise fall straight
    // through the scrim into the censored panel: a click-through could open a
    // chat and send a read receipt from a panel the user believes is hidden.
    // Declared before the controls so they stay on top of it.
    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.AllButtons
        hoverEnabled: true
        onWheel: function (wheel) {
            wheel.accepted = true;
        }
    }

    ColumnLayout {
        anchors.centerIn: parent
        width: Math.min(parent.width - Kirigami.Units.gridUnit * 2, Kirigami.Units.gridUnit * 16)
        spacing: Kirigami.Units.largeSpacing

        Kirigami.Icon {
            Layout.alignment: Qt.AlignHCenter
            Layout.preferredWidth: Kirigami.Units.iconSizes.large
            Layout.preferredHeight: Kirigami.Units.iconSizes.large
            source: "object-locked"
        }

        PlasmaComponents.Button {
            id: revealButton
            Layout.alignment: Qt.AlignHCenter
            icon.name: "view-visible"
            text: i18nc("@action:button", "Reveal")
            visible: !overlay.passwordRequired
            onClicked: overlay.revealRequested()
        }

        PlasmaComponents.Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            visible: overlay.passwordRequired
            text: i18nc("@info", "Enter your login password to reveal the panel.")
        }

        RowLayout {
            Layout.fillWidth: true
            visible: overlay.passwordRequired
            spacing: Kirigami.Units.smallSpacing

            PlasmaComponents.TextField {
                id: passwordField
                Layout.fillWidth: true
                echoMode: TextInput.Password
                // Keep the password out of every input-method side channel:
                // no predictive-text dictionary, no autocapitalisation, no
                // stored suggestion. echoMode already blocks copy and cut.
                inputMethodHints: Qt.ImhSensitiveData | Qt.ImhHiddenText
                    | Qt.ImhNoAutoUppercase | Qt.ImhNoPredictiveText
                placeholderText: i18nc("@info:placeholder", "Password")
                enabled: !overlay.busy
                onAccepted: overlay.submit(text)
            }

            PlasmaComponents.Button {
                icon.name: "object-unlocked"
                display: PlasmaComponents.AbstractButton.IconOnly
                text: i18nc("@action:button", "Unlock")
                // Reads the field's length only; the text itself never leaves
                // the field except through submit().
                enabled: !overlay.busy && passwordField.text.length > 0
                onClicked: overlay.submit(passwordField.text)
            }
        }

        PlasmaComponents.Label {
            Layout.fillWidth: true
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            visible: overlay.errorText.length > 0
            color: Kirigami.Theme.negativeTextColor
            text: overlay.errorText
        }
    }
}
