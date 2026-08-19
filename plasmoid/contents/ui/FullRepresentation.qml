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
            id: contentArea
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

    HideOverlay {
        anchors.fill: parent
        censorSource: contentArea
        visible: root.hidden
        onRevealRequested: root.reveal()
    }
}
