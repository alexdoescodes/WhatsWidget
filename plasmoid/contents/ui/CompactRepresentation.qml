import QtQuick
import org.kde.kirigami as Kirigami
import org.kde.plasma.plasmoid

MouseArea {
    id: compact

    Kirigami.Icon {
        anchors.fill: parent
        source: "internet-mail"
    }

    // Connection state dot: visible at a glance without opening the panel.
    // `root` is the PlasmoidItem (id: root in main.qml), made available here
    // as an implicit context property by Plasma when loading representations.
    // Verified against the shipped org.kde.plasma.systemmonitor and
    // org.kde.desktopcontainment CompactRepresentation.qml on this system
    // (Plasma 6.7.2), both of which use `root.expanded` the same way.
    Rectangle {
        width: Math.round(parent.width * 0.3)
        height: width
        radius: width / 2
        anchors.right: parent.right
        anchors.bottom: parent.bottom
        color: {
            switch (root.backend.status) {
            case "connected": return Kirigami.Theme.positiveTextColor;
            case "needs-pairing": return Kirigami.Theme.neutralTextColor;
            default: return Kirigami.Theme.negativeTextColor;
            }
        }
    }

    onClicked: root.expanded = !root.expanded
}
