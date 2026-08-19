import QtQuick
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    // Replaced by a live backend client in Task 9.
    readonly property var backend: ({ status: "connecting", unread: 0 })

    preferredRepresentation: compactRepresentation
    compactRepresentation: CompactRepresentation {}
    fullRepresentation: FullRepresentation {}
}
