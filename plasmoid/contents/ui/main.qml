import QtQuick
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    // Live client for the loopback backend. Representations reach it as
    // `root.backend` (Plasma injects `root` as the PlasmoidItem).
    readonly property BackendClient backend: BackendClient {}

    preferredRepresentation: compactRepresentation
    compactRepresentation: CompactRepresentation {}
    fullRepresentation: FullRepresentation {}
}
