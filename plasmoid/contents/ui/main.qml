import QtQuick
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root

    // Live client for the loopback backend. Representations reach it as
    // `root.backend` (Plasma injects `root` as the PlasmoidItem).
    readonly property BackendClient backend: BackendClient {}

    // Privacy hide state. hiddenSince is a plain timestamp, deliberately not
    // driven by a timer: elapsed time is computed only when someone actually
    // tries to reveal the panel, so nothing ticks in the background — not
    // while hidden and not while visible.
    property bool hidden: false
    property double hiddenSince: 0

    function hide() {
        root.hiddenSince = Date.now();
        root.hidden = true;
    }

    /**
     * The security gate: true when revealing must go through the login
     * password. Evaluated on demand — when the overlay appears, when the popup
     * is reopened, and again at the moment a reveal is requested.
     *
     * Every uncertain answer is "yes". A hide with no usable timestamp, a
     * clock that moved backwards, or a configuration value that is missing or
     * nonsensical all mean the elapsed time cannot be trusted, and an
     * untrustworthy measurement must not open the panel.
     */
    function passwordRequired() {
        if (!root.hidden) return false;
        if (!(root.hiddenSince > 0)) return true;

        const minutes = Plasmoid.configuration.lockAfterMinutes;
        if (typeof minutes !== "number" || !isFinite(minutes) || minutes < 0) return true;

        const elapsedMs = Date.now() - root.hiddenSince;
        if (!(elapsedMs >= 0)) return true;
        return elapsedMs >= minutes * 60000;
    }

    /**
     * Reveal on the user's own say-so. Returns false — and changes nothing —
     * once the threshold has passed, so this is safe to call from anywhere:
     * the check happens here, at the moment of the attempt, not at the moment
     * some caller last looked.
     */
    function reveal() {
        if (root.passwordRequired()) return false;
        root.clearHidden();
        return true;
    }

    /**
     * Reveal after the backend has verified the login password over /unlock.
     * The only path that bypasses passwordRequired(), and the only caller is
     * the success branch of that request.
     */
    function revealUnlocked() {
        root.clearHidden();
    }

    function clearHidden() {
        root.hidden = false;
        root.hiddenSince = 0;
    }

    preferredRepresentation: compactRepresentation
    compactRepresentation: CompactRepresentation {}
    fullRepresentation: FullRepresentation {}
}
