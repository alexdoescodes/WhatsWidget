import QtQuick
import org.kde.plasma.core as PlasmaCore
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
    // The threshold in force at the moment hide() ran. passwordRequired() uses
    // the stricter of this and the live setting, so reconfiguring can tighten
    // an in-progress hide but never loosen one.
    //
    // Without this the gate opens with no password at all: the config page is
    // reachable from Plasma's applet context menu, which the widget does not
    // own and cannot gate, so an onlooker at an unlocked desktop could raise
    // "require password after hidden for" to 1440 and turn a live password
    // prompt straight back into a free Reveal button.
    property int hiddenThreshold: 0

    /**
     * The configured threshold in minutes, or -1 when it cannot be trusted.
     * Missing, non-numeric, NaN and negative all read as untrustworthy —
     * note that `undefined * 60000` is NaN and `x >= NaN` is false, so a
     * config read that returns nothing would otherwise fail open.
     */
    function configuredMinutes() {
        const minutes = Plasmoid.configuration.lockAfterMinutes;
        if (typeof minutes !== "number" || !isFinite(minutes) || minutes < 0) return -1;
        return minutes;
    }

    function hide() {
        // An untrustworthy reading snapshots as 0 — always require the
        // password — because it must never be able to widen a hide.
        const snapshot = root.configuredMinutes();
        root.hiddenThreshold = snapshot < 0 ? 0 : snapshot;
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

        const live = root.configuredMinutes();
        if (live < 0) return true;

        // The stricter of the snapshot and the live setting: a threshold
        // raised after the fact cannot extend the free-reveal window.
        const minutes = Math.min(root.hiddenThreshold, live);

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
        // Back to the strictest default, so a stale snapshot can never be the
        // value in force if `hidden` is ever set without going through hide().
        root.hiddenThreshold = 0;
    }

    // On the desktop the widget is a resizable tile with room to spare, so
    // show the chat panel itself rather than an icon that has to be clicked.
    // In a panel there is no such room, so it stays a compact icon with the
    // unread badge and opens the panel as a popup.
    // Planar (0) is the desktop containment; Horizontal/Vertical are panels.
    readonly property bool inlineOnDesktop: Plasmoid.formFactor === PlasmaCore.Types.Planar

    // Whether the chat panel is actually on screen, by either route. `expanded`
    // only tracks the popup, and there is no popup when the full representation
    // is displayed inline — so anything that should run "while the user can see
    // the panel" has to consult this, not `expanded` alone.
    readonly property bool panelOnScreen: root.inlineOnDesktop || root.expanded

    preferredRepresentation: root.inlineOnDesktop ? fullRepresentation : compactRepresentation
    compactRepresentation: CompactRepresentation {}
    fullRepresentation: FullRepresentation {}
}
