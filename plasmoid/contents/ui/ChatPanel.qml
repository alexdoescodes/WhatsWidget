pragma ComponentBehavior: Bound

import QtQml
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
 * polls, and nothing here animates or runs an effect — the widget is meant to
 * cost nothing while it sits on the desktop.
 *
 * The panel deliberately has no title bar of its own. The owner
 * (FullRepresentation) draws one header for the whole widget and adapts it to
 * `activeJid`, which is why that property and closeChat()/chatName() are part
 * of this file's surface rather than private state.
 */
ColumnLayout {
    id: panel

    required property var backend
    property string activeJid: ""
    // Free-text filter over the chat list, driven by the header's search box.
    property string filter: ""
    // Whether the list is showing archived conversations instead of active
    // ones. Archive state is read-only here: it is set on the phone (or
    // another linked device) and arrives over chats.update. The widget never
    // writes it back, so nothing it does can rearrange the real account.
    property bool showArchived: false
    // Whether chats the user removed from the widget are being shown, so they
    // can be put back. Removal is local to this widget -- see the context
    // menu on a chat row.
    property bool showHidden: false

    spacing: 0

    // Row metrics, shared so the avatar, the row separator's inset and the
    // unread badge cannot drift apart.
    readonly property int avatarSize: Kirigami.Units.gridUnit * 2
    readonly property int badgeSize: Math.round(Kirigami.Units.gridUnit)
    readonly property int rowPadding: Kirigami.Units.largeSpacing

    /**
     * The chats the list actually shows. Recomputed only when the backend
     * pushes a new list or the user types — there is no timer behind it.
     */
    readonly property var visibleChats: {
        const needle = panel.filter.trim().toLowerCase();
        if (needle.length > 0) {
            // Search deliberately spans the archive. A chat you filed away is
            // still a chat you might be looking for, and having search quietly
            // skip half the account is worse than showing one extra result.
            return panel.backend.chats.filter(function (chat) {
                if (Boolean(chat.hidden) !== panel.showHidden) return false;
                return String(chat.name).toLowerCase().indexOf(needle) >= 0;
            });
        }
        return panel.backend.chats.filter(function (chat) {
            if (panel.showHidden) return Boolean(chat.hidden);
            if (chat.hidden) return false;
            return Boolean(chat.archived) === panel.showArchived;
        });
    }

    readonly property int hiddenCount: panel.backend.chats.filter(function (chat) {
        return Boolean(chat.hidden);
    }).length

    readonly property var archivedChats: panel.backend.chats.filter(function (chat) {
        return Boolean(chat.archived);
    })

    readonly property int archivedUnread: {
        var total = 0;
        for (var i = 0; i < panel.archivedChats.length; i++) {
            total += panel.archivedChats[i].unread || 0;
        }
        return total;
    }

    // The archive row is pointless while searching, since search already
    // reaches into it.
    // The row above the list: the way into the archive, and the way back out
    // of either sub-list. Pointless while searching, which already spans them.
    readonly property bool archiveRowVisible: panel.showHidden
        || (panel.filter.trim().length === 0
            && (panel.showArchived || panel.archivedChats.length > 0))

    /**
     * What to show for a chat with no name.
     *
     * Not every conversation has one: a number that is not in the address
     * book has nothing to be called, exactly as in WhatsApp itself. The
     * backend leaves `name` equal to the jid in that case, which is honest
     * but unreadable — "491792369811@s.whatsapp.net" rather than a phone
     * number. Only the address form is dressed up here; no name is invented.
     */
    function displayName(jid, name) {
        if (name && name !== jid) return name;

        var at = String(jid).indexOf("@");
        if (at < 0) return jid;
        var user = String(jid).slice(0, at);
        var server = String(jid).slice(at + 1);

        // A phone-number jid really is the number, so show it as one.
        if (server === "s.whatsapp.net" || server === "c.us") return "+" + user;
        // A LID is deliberately opaque — it is not a number and must not be
        // shown as though it were one.
        if (server === "lid") return i18nc("@item an unidentified contact", "Unknown contact");
        if (server === "newsletter") return i18nc("@item an unnamed channel", "Channel");
        if (server === "g.us") return i18nc("@item a group with no subject", "Group");
        return jid;
    }

    // The chat list carries display names; a conversation only knows its JID.
    function chatName(jid) {
        var chats = panel.backend.chats;
        for (var i = 0; i < chats.length; i++) {
            if (chats[i].jid === jid) return panel.displayName(jid, chats[i].name);
        }
        return panel.displayName(jid, "");
    }

    /**
     * A one-line preview of the newest message.
     *
     * Guarded rather than read straight off the record: a backend from before
     * the preview field existed sends chats without it, and the panel should
     * degrade to a name-only row instead of printing "undefined". Newlines are
     * flattened because this is one line of a fixed-height row.
     */
    function previewText(chat) {
        if (!chat || !chat.lastMessageText) return "";
        return String(chat.lastMessageText).replace(/\s+/g, " ").trim();
    }

    /**
     * The right-hand timestamp. `lastMessageAt` is a Unix time in *seconds*
     * (Baileys' messageTimestamp, passed through the store unchanged), so it
     * needs scaling before Date sees it.
     *
     * Today's chats show a clock time and older ones a short date. The
     * "today" test reads the wall clock at binding time; nothing re-runs it on
     * a schedule, so a panel left open across midnight keeps yesterday's
     * labels until the next push. That is the correct trade here — the
     * alternative is a timer ticking all night for a cosmetic refresh.
     */
    function timeLabel(unixSeconds) {
        if (!(unixSeconds > 0)) return "";
        const when = new Date(unixSeconds * 1000);
        const now = new Date();
        const sameDay = when.getFullYear() === now.getFullYear()
            && when.getMonth() === now.getMonth()
            && when.getDate() === now.getDate();
        return sameDay ? Qt.formatTime(when, "hh:mm")
                       : Qt.formatDate(when, Locale.ShortFormat);
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
    Item {
        Layout.fillWidth: true
        Layout.fillHeight: true
        visible: panel.activeJid === ""

        PlasmaComponents.ItemDelegate {
            id: archiveRow

            anchors.top: parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            height: visible ? implicitHeight : 0
            visible: panel.archiveRowVisible
            onClicked: {
                if (panel.showHidden) panel.showHidden = false;
                else panel.showArchived = !panel.showArchived;
            }

            contentItem: RowLayout {
                spacing: panel.rowPadding

                Kirigami.Icon {
                    Layout.preferredWidth: Kirigami.Units.iconSizes.small
                    Layout.preferredHeight: Kirigami.Units.iconSizes.small
                    source: (panel.showArchived || panel.showHidden)
                        ? "go-previous" : "archive-symbolic"
                    isMask: true
                    color: Kirigami.Theme.highlightColor
                }

                PlasmaComponents.Label {
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                    font.bold: panel.showArchived || panel.showHidden
                    text: panel.showHidden ? i18n("Removed from widget") : i18n("Archived")
                }

                // Only ever an unread count, never the number of archived
                // chats: the whole point of archiving is that the chat stops
                // asking for attention.
                PlasmaComponents.Label {
                    visible: !panel.showArchived && !panel.showHidden
                        && panel.archivedUnread > 0
                    color: Kirigami.Theme.disabledTextColor
                    text: panel.archivedUnread > 99 ? "99+" : String(panel.archivedUnread)
                }
            }
        }

        Kirigami.Separator {
            id: archiveSeparator
            anchors.top: archiveRow.bottom
            anchors.left: parent.left
            anchors.right: parent.right
            visible: archiveRow.visible
        }

        PlasmaComponents.ScrollView {
            anchors.top: archiveRow.visible ? archiveSeparator.bottom : parent.top
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom

            // ScrollView takes a single Flickable as its content item and
            // drives it; the ListView must therefore not be anchored or sized
            // here.
            ListView {
                id: chatList

                model: panel.visibleChats
                clip: true

                delegate: PlasmaComponents.ItemDelegate {
                    id: chatDelegate

                    required property var modelData
                    required property int index

                    readonly property string preview: panel.previewText(chatDelegate.modelData)

                    width: chatList.width
                    topPadding: panel.rowPadding
                    bottomPadding: panel.rowPadding
                    leftPadding: panel.rowPadding
                    rightPadding: panel.rowPadding

                    onClicked: panel.openChat(chatDelegate.modelData.jid)

                    // Right-click removes the chat from this widget. Accepts
                    // only the right button, so the delegate still gets the
                    // ordinary left click that opens the conversation.
                    MouseArea {
                        anchors.fill: parent
                        acceptedButtons: Qt.RightButton
                        onClicked: rowMenu.popup()
                    }

                    PlasmaComponents.Menu {
                        id: rowMenu

                        PlasmaComponents.MenuItem {
                            icon.name: panel.showHidden ? "list-add" : "list-remove"
                            // Deliberately not "Delete": nothing is deleted.
                            // The conversation stays in WhatsApp and on every
                            // other device; only this widget stops listing it.
                            text: panel.showHidden
                                ? i18nc("@action:inmenu", "Show in widget again")
                                : i18nc("@action:inmenu", "Remove from widget")
                            onTriggered: panel.backend.setChatHidden(
                                chatDelegate.modelData.jid, !panel.showHidden)
                        }
                    }

                    // The stock ItemDelegate background is replaced so the row
                    // separator can be inset past the avatar, the way the
                    // design has it. Hover and press feedback is rebuilt here
                    // as plain alpha over the accent colour — no effect, no
                    // shadow, nothing that repaints unless the pointer moves.
                    background: Rectangle {
                        readonly property color accent: Kirigami.Theme.highlightColor

                        color: chatDelegate.pressed
                            ? Qt.rgba(accent.r, accent.g, accent.b, 0.30)
                            : chatDelegate.hovered
                                ? Qt.rgba(accent.r, accent.g, accent.b, 0.15)
                                : "transparent"

                        Kirigami.Separator {
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.bottom: parent.bottom
                            anchors.leftMargin: panel.rowPadding + panel.avatarSize
                                + Kirigami.Units.largeSpacing
                            // The last row has nothing below it to be
                            // separated from.
                            visible: chatDelegate.index < chatList.count - 1
                        }
                    }

                    contentItem: RowLayout {
                        spacing: Kirigami.Units.largeSpacing

                        ChatAvatar {
                            Layout.preferredWidth: panel.avatarSize
                            Layout.preferredHeight: panel.avatarSize
                            Layout.alignment: Qt.AlignVCenter
                            jid: chatDelegate.modelData.jid
                            name: panel.displayName(chatDelegate.modelData.jid,
                                                    chatDelegate.modelData.name)
                        }

                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 0

                            PlasmaComponents.Label {
                                Layout.fillWidth: true
                                elide: Text.ElideRight
                                maximumLineCount: 1
                                font.bold: true
                                text: panel.displayName(chatDelegate.modelData.jid,
                                                        chatDelegate.modelData.name)
                            }

                            RowLayout {
                                Layout.fillWidth: true
                                spacing: Kirigami.Units.smallSpacing
                                // A chat whose backend predates the preview
                                // field collapses back to a single-line row
                                // rather than reserving space for nothing.
                                visible: chatDelegate.preview.length > 0

                                PlasmaComponents.Label {
                                    // The "sent by you" double check. U+2713
                                    // twice, kerned together — measured as
                                    // rendering through font fallback on this
                                    // system; there is no Breeze icon for it,
                                    // and two stacked icon items per row would
                                    // cost more than two glyphs.
                                    text: "✓✓"
                                    font.pixelSize: Kirigami.Theme.smallFont.pixelSize
                                    // Kerned together so the pair reads as one
                                    // double-check mark rather than two ticks.
                                    font.letterSpacing: -Math.round(
                                        Kirigami.Theme.smallFont.pixelSize * 0.3)
                                    color: Kirigami.Theme.disabledTextColor
                                    visible: chatDelegate.modelData.lastMessageFromMe === true
                                }

                                PlasmaComponents.Label {
                                    Layout.fillWidth: true
                                    elide: Text.ElideRight
                                    maximumLineCount: 1
                                    font: Kirigami.Theme.smallFont
                                    color: Kirigami.Theme.disabledTextColor
                                    text: chatDelegate.preview
                                }
                            }
                        }

                        ColumnLayout {
                            Layout.fillHeight: true
                            Layout.alignment: Qt.AlignVCenter
                            spacing: Kirigami.Units.smallSpacing

                            PlasmaComponents.Label {
                                Layout.alignment: Qt.AlignRight | Qt.AlignTop
                                font: Kirigami.Theme.smallFont
                                color: chatDelegate.modelData.unread > 0
                                    ? Kirigami.Theme.highlightColor
                                    : Kirigami.Theme.disabledTextColor
                                text: panel.timeLabel(chatDelegate.modelData.lastMessageAt)
                            }

                            Item { Layout.fillHeight: true }

                            Rectangle {
                                Layout.alignment: Qt.AlignRight | Qt.AlignBottom
                                Layout.preferredHeight: panel.badgeSize
                                Layout.preferredWidth: Math.max(
                                    unreadLabel.implicitWidth + Kirigami.Units.smallSpacing * 2,
                                    panel.badgeSize)
                                radius: height / 2
                                color: Kirigami.Theme.highlightColor
                                visible: chatDelegate.modelData.unread > 0

                                PlasmaComponents.Label {
                                    id: unreadLabel
                                    anchors.centerIn: parent
                                    font: Kirigami.Theme.smallFont
                                    color: Kirigami.Theme.highlightedTextColor
                                    text: chatDelegate.modelData.unread > 99
                                        ? i18nc("@info shortened unread count", "99+")
                                        : String(chatDelegate.modelData.unread)
                                }
                            }
                        }
                    }
                }
            }
        }

        PlasmaComponents.Label {
            anchors.centerIn: parent
            width: parent.width - Kirigami.Units.gridUnit * 2
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.WordWrap
            color: Kirigami.Theme.disabledTextColor
            visible: chatList.count === 0
            text: {
                if (panel.filter.trim().length > 0)
                    return i18nc("@info:placeholder", "No chats match “%1”.", panel.filter.trim());
                if (panel.showHidden)
                    return i18nc("@info:placeholder", "No removed chats.");
                if (panel.showArchived)
                    return i18nc("@info:placeholder", "No archived chats.");
                return i18nc("@info:placeholder", "No chats yet.");
            }
        }
    }

    // --- Conversation (shown when a chat is open) ---
    PlasmaComponents.ScrollView {
        Layout.fillWidth: true
        Layout.fillHeight: true
        Layout.topMargin: Kirigami.Units.smallSpacing
        Layout.leftMargin: Kirigami.Units.smallSpacing
        Layout.rightMargin: Kirigami.Units.smallSpacing
        visible: panel.activeJid !== ""

        ListView {
            id: messageList
            model: messageModel
            spacing: Kirigami.Units.smallSpacing
            clip: true

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

                width: messageList.width
                height: bubble.height

                Rectangle {
                    id: bubble

                    anchors.right: messageRow.fromMe ? parent.right : undefined
                    anchors.left: messageRow.fromMe ? undefined : parent.left
                    width: Math.min(bubbleText.implicitWidth + Kirigami.Units.largeSpacing * 2,
                                    messageRow.width * 0.82)
                    height: bubbleText.implicitHeight + Kirigami.Units.smallSpacing * 2
                    radius: Kirigami.Units.cornerRadius * 2
                    color: messageRow.fromMe ? Kirigami.Theme.highlightColor
                                             : Kirigami.Theme.alternateBackgroundColor

                    PlasmaComponents.Label {
                        id: bubbleText
                        anchors.centerIn: parent
                        width: parent.width - Kirigami.Units.largeSpacing * 2
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

    Kirigami.Separator {
        Layout.fillWidth: true
        Layout.topMargin: Kirigami.Units.smallSpacing
        visible: panel.activeJid !== ""
    }

    RowLayout {
        Layout.fillWidth: true
        Layout.margins: Kirigami.Units.smallSpacing
        spacing: Kirigami.Units.smallSpacing
        visible: panel.activeJid !== ""

        PlasmaComponents.TextField {
            id: composer
            Layout.fillWidth: true
            placeholderText: i18n("Message…")
            onAccepted: panel.sendComposed()
        }

        PlasmaComponents.ToolButton {
            icon.name: "document-send"
            display: PlasmaComponents.AbstractButton.IconOnly
            text: i18nc("@action:button", "Send")
            enabled: composer.text.length > 0
            onClicked: panel.sendComposed()
        }
    }
}
