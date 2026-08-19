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

    PairingView {
        anchors.centerIn: parent
        width: parent.width - Kirigami.Units.gridUnit * 2
        backend: full.backend
        visible: full.backend.status === "needs-pairing"
        // Fetching the code costs a loopback request, so only do it while the
        // popup is actually open on a backend that wants pairing.
        active: visible && root.expanded
    }

    PlasmaComponents.Label {
        anchors.centerIn: parent
        visible: full.backend.status !== "needs-pairing" && full.backend.status !== "connected"
        text: i18n("Connecting…")
    }

    // Chat UI lands here in Task 11.
    Item {
        id: chatArea
        anchors.fill: parent
        visible: full.backend.status === "connected"
    }
}
