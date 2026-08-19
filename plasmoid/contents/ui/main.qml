import QtQuick
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    // Live client for the loopback backend. Representations reach it as
    // `root.backend` (Plasma injects `root` as the PlasmoidItem).
    readonly property BackendClient backend: BackendClient {}

    // Privacy hide state. hiddenSince is a plain timestamp, deliberately not
    // driven by a timer: elapsed time is computed only when the user tries to
    // reveal, so nothing ticks in the background. Task 14 adds the password
    // gate that reads hiddenSince and clears both properties on unlock; for
    // now reveal() is unconditional.
    property bool hidden: false
    property double hiddenSince: 0

    function hide() {
        root.hiddenSince = Date.now();
        root.hidden = true;
    }

    function reveal() {
        root.hidden = false;
        root.hiddenSince = 0;
    }

    preferredRepresentation: compactRepresentation
    compactRepresentation: CompactRepresentation {}
    fullRepresentation: FullRepresentation {}
}
