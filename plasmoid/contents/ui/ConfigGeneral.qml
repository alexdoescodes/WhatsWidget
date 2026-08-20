import QtQuick
import QtQuick.Controls as QQC2
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.kcmutils as KCM

/**
 * Widget settings. The only knob is how long the panel may sit hidden before
 * revealing it needs the login password again; 0 means "every time".
 *
 * The root has to be a KCM page, not the bare FormLayout: Plasma's config
 * dialog pushes this into a Kirigami.PageRow and sets `title` on it, and a
 * plain layout is neither — it lands outside the scene and the page renders
 * empty. Verified against the real dialog under plasmoidviewer.
 */
KCM.SimpleKCM {
    property alias cfg_lockAfterMinutes: lockAfter.value

    Kirigami.FormLayout {
        anchors.left: parent.left
        anchors.right: parent.right

        QQC2.SpinBox {
            id: lockAfter

            Kirigami.FormData.label: i18nc("@label:spinbox", "Require password after hidden for:")
            // Mirrors the <min>/<max> in config/main.xml.
            from: 0
            to: 1440
            editable: true

            textFromValue: function (value, locale) {
                return value === 0
                    ? i18nc("@item require the password on every reveal", "Always")
                    : i18ncp("@item:valuesuffix minutes hidden before the password is required",
                             "%1 minute", "%1 minutes", value);
            }
            valueFromText: function (text, locale) {
                const parsed = parseInt(text, 10);
                return isNaN(parsed) ? 0 : parsed;
            }
        }

        QQC2.Label {
            Layout.fillWidth: true
            Layout.maximumWidth: Kirigami.Units.gridUnit * 24
            wrapMode: Text.WordWrap
            text: i18nc("@info", "Hiding the panel always censors it immediately. This only controls how soon revealing it asks for your login password.")
        }
    }
}
