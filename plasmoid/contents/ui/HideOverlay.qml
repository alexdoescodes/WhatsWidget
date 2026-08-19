import QtQuick
import QtQuick.Layouts
import QtQuick.Effects
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

/**
 * Censors the panel contents. The blur is a MultiEffect over a live source,
 * but it is only instantiated while hidden — when visible: false, nothing is
 * rendered or computed at all, so the cost is zero in the normal case.
 *
 * The scrim underneath it is fully opaque, not translucent. Measured on this
 * system (Plasma 6.7.2 / Qt 6.11, both software-offscreen and a real
 * GPU-composited Wayland output): MultiEffect's blur pass is inconsistent —
 * it ranged from a no-op to a soft edge halo that still left text fully
 * readable underneath, and dialing the scrim to a translucent 0.55 (or even
 * 0.97) left chat names legible through it. A privacy screen that sometimes
 * leaks the screen it's supposed to censor is worse than no feature at all,
 * so occlusion here does not depend on the blur actually working: the opaque
 * Rectangle is the guarantee, and the blur is left in only as a harmless
 * decorative layer entirely hidden behind it.
 */
Item {
    id: overlay

    required property Item censorSource

    signal revealRequested()

    MultiEffect {
        anchors.fill: parent
        source: overlay.censorSource
        blurEnabled: true
        blur: 1.0
        blurMax: 48
        // Static blur: no animation, computed once per toggle rather than per frame.
        autoPaddingEnabled: false
    }

    Rectangle {
        anchors.fill: parent
        color: Kirigami.Theme.backgroundColor
    }

    ColumnLayout {
        anchors.centerIn: parent
        spacing: Kirigami.Units.largeSpacing

        Kirigami.Icon {
            Layout.alignment: Qt.AlignHCenter
            Layout.preferredWidth: Kirigami.Units.iconSizes.large
            Layout.preferredHeight: Kirigami.Units.iconSizes.large
            source: "object-locked"
        }

        PlasmaComponents.Button {
            Layout.alignment: Qt.AlignHCenter
            icon.name: "view-visible"
            text: i18n("Reveal")
            onClicked: overlay.revealRequested()
        }
    }
}
