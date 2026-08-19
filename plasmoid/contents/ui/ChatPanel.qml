pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

/**
 * The mini chat panel: a list of chats, one open conversation, and a composer.
 *
 * Everything here is push driven. The chat list is whatever `backend.chats`
 * currently holds (the client replaces it when the backend pushes an event),
 * and an open conversation grows from the `messageReceived` signal. Nothing
 * polls.
 */
ColumnLayout {
    id: panel

    required property var backend
    property string activeJid: ""

    spacing: Kirigami.Units.smallSpacing

    // The chat list carries display names; a conversation only knows its JID.
    function chatName(jid) {
        var chats = panel.backend.chats;
        for (var i = 0; i < chats.length; i++) {
            if (chats[i].jid === jid) return chats[i].name;
        }
        return jid;
    }

    function openChat(jid) {
        panel.activeJid = jid;
        messageModel.clear();
        panel.backend.loadMessages(jid, function (err, messages) {
            // A load that raced with closing the chat must not paint into the
            // one that is open now.
            if (err || panel.activeJid !== jid) return;
            for (var i = 0; i < messages.length; i++) messageModel.append(messages[i]);
        });
        panel.backend.markRead(jid);
    }

    function closeChat() {
        panel.activeJid = "";
        messageModel.clear();
    }

    function sendComposed() {
        var text = composer.text;
        if (text.length === 0) return;
        composer.text = "";
        panel.backend.send(panel.activeJid, text, function (err) {
            if (err) {
                // Nothing was delivered, so give the text back rather than
                // silently eating it.
                composer.text = text;
                return;
            }
            // The backend does not write sent messages to its store; Baileys
            // echoes them back as an inbound event, which the handler below
            // deliberately ignores. So this append is the only one.
            messageModel.append({ id: "local", fromMe: true, text: text, timestamp: 0 });
        });
    }

    ListModel { id: messageModel }

    Connections {
        target: panel.backend

        function onMessageReceived(jid, message) {
            // Outgoing messages are echoed back by WhatsApp itself. The
            // composer has already appended them, so taking these too would
            // show every sent message twice.
            if (message.fromMe) return;
            if (jid !== panel.activeJid) return;
            messageModel.append(message);
            panel.backend.markRead(jid);
        }
    }

    // --- Chat list (shown when no chat is open) ---
    PlasmaComponents.ScrollView {
        Layout.fillWidth: true
        Layout.fillHeight: true
        visible: panel.activeJid === ""

        // ScrollView takes a single Flickable as its content item and drives
        // it; the ListView must therefore not be anchored or sized here.
        ListView {
            model: panel.backend.chats

            delegate: PlasmaComponents.ItemDelegate {
                id: chatDelegate

                required property var modelData

                width: ListView.view.width
                onClicked: panel.openChat(chatDelegate.modelData.jid)

                // Replacing the default icon+text content item keeps a long
                // chat name from running underneath the unread count.
                contentItem: RowLayout {
                    spacing: Kirigami.Units.smallSpacing

                    Kirigami.Icon {
                        source: "user-identity"
                        Layout.preferredWidth: Kirigami.Units.iconSizes.small
                        Layout.preferredHeight: Kirigami.Units.iconSizes.small
                    }

                    PlasmaComponents.Label {
                        Layout.fillWidth: true
                        elide: Text.ElideRight
                        text: chatDelegate.modelData.name
                    }

                    PlasmaComponents.Label {
                        visible: chatDelegate.modelData.unread > 0
                        text: chatDelegate.modelData.unread
                        color: Kirigami.Theme.highlightColor
                    }
                }
            }
        }
    }

    // --- Conversation (shown when a chat is open) ---
    RowLayout {
        Layout.fillWidth: true
        visible: panel.activeJid !== ""

        PlasmaComponents.ToolButton {
            icon.name: "go-previous"
            onClicked: panel.closeChat()
        }

        PlasmaComponents.Label {
            Layout.fillWidth: true
            elide: Text.ElideRight
            text: panel.chatName(panel.activeJid)
        }
    }

    PlasmaComponents.ScrollView {
        Layout.fillWidth: true
        Layout.fillHeight: true
        visible: panel.activeJid !== ""

        ListView {
            id: messageList
            model: messageModel
            spacing: Kirigami.Units.smallSpacing

            // Keep the newest message in view. Positioning right after the
            // appends is not enough: opening a chat also makes this view
            // visible, and the layout pass that follows resets the position.
            // Reacting to both the row count and the final geometry covers it,
            // and Qt.callLater() collapses a burst of appends into one call.
            onCountChanged: Qt.callLater(messageList.positionViewAtEnd)
            onHeightChanged: Qt.callLater(messageList.positionViewAtEnd)

            delegate: Item {
                id: messageRow

                required property bool fromMe
                required property string text

                width: ListView.view.width
                height: bubble.height

                Rectangle {
                    id: bubble

                    anchors.right: messageRow.fromMe ? parent.right : undefined
                    anchors.left: messageRow.fromMe ? undefined : parent.left
                    width: Math.min(bubbleText.implicitWidth + Kirigami.Units.largeSpacing,
                                    messageRow.width * 0.8)
                    height: bubbleText.implicitHeight + Kirigami.Units.smallSpacing * 2
                    radius: Kirigami.Units.cornerRadius
                    color: messageRow.fromMe ? Kirigami.Theme.highlightColor
                                             : Kirigami.Theme.alternateBackgroundColor

                    PlasmaComponents.Label {
                        id: bubbleText
                        anchors.centerIn: parent
                        width: parent.width - Kirigami.Units.largeSpacing
                        wrapMode: Text.WordWrap
                        text: messageRow.text
                        // The highlight colour is a background here, so the
                        // theme's normal text colour is not guaranteed to be
                        // readable on it.
                        color: messageRow.fromMe ? Kirigami.Theme.highlightedTextColor
                                                 : Kirigami.Theme.textColor
                    }
                }
            }
        }
    }

    RowLayout {
        Layout.fillWidth: true
        visible: panel.activeJid !== ""

        PlasmaComponents.TextField {
            id: composer
            Layout.fillWidth: true
            placeholderText: i18n("Message…")
            onAccepted: panel.sendComposed()
        }

        PlasmaComponents.ToolButton {
            icon.name: "document-send"
            enabled: composer.text.length > 0
            onClicked: panel.sendComposed()
        }
    }
}
