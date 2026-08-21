import QtQuick
import QtQuick.Layouts
import org.kde.kirigami as Kirigami
import org.kde.plasma.components as PlasmaComponents

Item {
    id: full

    // `root` is the PlasmoidItem (id: root in main.qml); Plasma injects it as
    // an implicit context property when loading a representation.
    readonly property var backend: root.backend

    // Sized for a compact chat tile on the desktop rather than a full window:
    // at the usual gridUnit of 18 this is a 234x288 floor and a 270x360
    // default. The floor still has to fit a readable chat row plus the tab
    // bar, so it is not lowered further.
    Layout.minimumWidth: Kirigami.Units.gridUnit * 13
    Layout.minimumHeight: Kirigami.Units.gridUnit * 16
    Layout.preferredWidth: Kirigami.Units.gridUnit * 15
    Layout.preferredHeight: Kirigami.Units.gridUnit * 20

    // Which bottom tab is selected. 0 is Chats and is the only one backed by
    // anything; see the tab bar below.
    property int currentTab: 0
    // Whether the header has swapped its title for the search box.
    property bool searching: false

    readonly property bool chatOpen: chatPanel.activeJid !== ""

    // The whole widget, gated on the hide state. This is one item on purpose:
    // header, content and tab bar all sit under the single `visible` binding
    // below, so there is no way to add a strip of chrome that keeps rendering
    // — or keeps taking clicks — while the panel is supposed to be censored.
    //
    // Nothing secret is even rendered while the widget is hidden. The opaque
    // scrim above is the guarantee, but not drawing the panel at all is both
    // the stronger privacy answer and the cheaper one: a message arriving
    // while hidden no longer repaints a chat list nobody can see. An invisible
    // item also takes no input, so there is no click-through into a "hidden"
    // panel.
    ColumnLayout {
        anchors.fill: parent
        spacing: 0
        visible: !root.hidden

        // --- Header ---
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: headerRow.implicitHeight
                + Kirigami.Units.smallSpacing * 2
            color: Kirigami.Theme.alternateBackgroundColor

            RowLayout {
                id: headerRow

                anchors.fill: parent
                anchors.leftMargin: Kirigami.Units.smallSpacing
                anchors.rightMargin: Kirigami.Units.smallSpacing
                spacing: Kirigami.Units.smallSpacing

                PlasmaComponents.ToolButton {
                    icon.name: "go-previous"
                    display: PlasmaComponents.AbstractButton.IconOnly
                    text: i18nc("@action:button", "Back to the chat list")
                    visible: full.chatOpen
                    onClicked: chatPanel.closeChat()
                }

                // The app mark. WhatsApp green is hardcoded because it is the
                // one colour on this panel that is not the widget's to choose:
                // it identifies the service, and a theme role would repaint it
                // to whatever accent the user happens to run.
                Rectangle {
                    Layout.preferredWidth: Kirigami.Units.iconSizes.smallMedium
                    Layout.preferredHeight: Kirigami.Units.iconSizes.smallMedium
                    Layout.alignment: Qt.AlignVCenter
                    radius: width / 2
                    color: "#25d366"
                    visible: !full.chatOpen

                    Kirigami.Icon {
                        anchors.centerIn: parent
                        width: Math.round(parent.width * 0.62)
                        height: width
                        source: "dialog-messages"
                        isMask: true
                        // On the brand green, not on the scheme background.
                        color: "white"
                    }
                }

                ChatAvatar {
                    Layout.preferredWidth: Kirigami.Units.iconSizes.smallMedium
                    Layout.preferredHeight: Kirigami.Units.iconSizes.smallMedium
                    Layout.alignment: Qt.AlignVCenter
                    visible: full.chatOpen
                    jid: chatPanel.activeJid
                    name: chatPanel.chatName(chatPanel.activeJid)
                }

                PlasmaComponents.Label {
                    Layout.fillWidth: true
                    elide: Text.ElideRight
                    maximumLineCount: 1
                    font.bold: true
                    visible: !full.searching || full.chatOpen
                    text: full.chatOpen ? chatPanel.chatName(chatPanel.activeJid)
                                        : i18n("WhatsApp")
                }

                PlasmaComponents.TextField {
                    id: searchField
                    Layout.fillWidth: true
                    visible: full.searching && !full.chatOpen
                    placeholderText: i18nc("@info:placeholder", "Search chats")
                    onVisibleChanged: if (searchField.visible) searchField.forceActiveFocus()
                    Keys.onEscapePressed: function (event) {
                        full.stopSearching();
                        event.accepted = true;
                    }
                }

                PlasmaComponents.ToolButton {
                    // edit-find, not "search": Breeze's `search` icon is a
                    // full-colour blue magnifier that fights every colour
                    // scheme it lands on. edit-find and dialog-close are
                    // monochrome and follow the theme, like the kebab beside
                    // them.
                    icon.name: full.searching ? "dialog-close" : "edit-find"
                    display: PlasmaComponents.AbstractButton.IconOnly
                    text: full.searching ? i18nc("@action:button", "Clear search")
                                         : i18nc("@action:button", "Search chats")
                    visible: !full.chatOpen
                    onClicked: {
                        if (full.searching) full.stopSearching();
                        else full.searching = true;
                    }
                }

                PlasmaComponents.ToolButton {
                    id: overflowButton
                    icon.name: "overflow-menu"
                    display: PlasmaComponents.AbstractButton.IconOnly
                    text: i18nc("@action:button", "More options")
                    onClicked: overflowMenu.popup(overflowButton, 0, overflowButton.height)
                }
            }

            Kirigami.Separator {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.bottom: parent.bottom
            }

            // The design has no visible Hide button, so the control moves in
            // here: one click on the kebab, one on the item. It is the first
            // entry precisely so that "make this go away, now" stays a
            // two-step gesture and never becomes a hunt.
            PlasmaComponents.Menu {
                id: overflowMenu

                PlasmaComponents.MenuItem {
                    icon.name: "view-hidden"
                    text: i18nc("@action:inmenu", "Hide panel")
                    onTriggered: root.hide()
                }

                PlasmaComponents.MenuItem {
                    icon.name: "list-remove"
                    text: i18nc("@action:inmenu", "Removed chats")
                    // Only worth offering once something has been removed;
                    // right-clicking a chat row is what puts things here.
                    enabled: chatPanel.hiddenCount > 0
                    onTriggered: {
                        chatPanel.closeChat();
                        chatPanel.showHidden = true;
                    }
                }
            }
        }

        // --- Content ---
        Item {
            Layout.fillWidth: true
            Layout.fillHeight: true

            PairingView {
                anchors.centerIn: parent
                width: parent.width - Kirigami.Units.gridUnit * 2
                backend: full.backend
                visible: full.currentTab === 0 && full.backend.status === "needs-pairing"
                // Fetching the code costs a loopback request, so only do it
                // while the panel is actually on screen on a backend that
                // wants pairing. Inline on the desktop there is no popup and
                // `expanded` never becomes true, so gating on it alone would
                // leave the QR permanently unfetched and pairing impossible.
                active: visible && root.panelOnScreen
            }

            PlasmaComponents.Label {
                anchors.centerIn: parent
                visible: full.currentTab === 0 && full.backend.status !== "needs-pairing"
                    && full.backend.status !== "connected"
                text: i18n("Connecting…")
            }

            ChatPanel {
                id: chatPanel
                anchors.fill: parent
                backend: full.backend
                visible: full.currentTab === 0 && full.backend.status === "connected"
            }

            // Status and Calls are drawn in the tab bar because the design
            // asks for a three-tab bar, but this widget has no status feed and
            // no call log — the backend exposes chats, messages and an unread
            // count, and nothing else. Rather than invent a plausible-looking
            // list, selecting one of them says so.
            PlasmaComponents.Label {
                anchors.centerIn: parent
                width: parent.width - Kirigami.Units.gridUnit * 2
                horizontalAlignment: Text.AlignHCenter
                wrapMode: Text.WordWrap
                color: Kirigami.Theme.disabledTextColor
                visible: full.currentTab !== 0
                text: full.currentTab === 1
                    ? i18nc("@info:placeholder", "Status updates are not available in this widget.")
                    : i18nc("@info:placeholder", "Calls are not available in this widget.")
            }
        }

        // --- Bottom tab bar ---
        // Hidden while a conversation is open: the composer needs that strip
        // more than a tab bar does on a panel this size, and the header's back
        // button is the way out of a chat anyway.
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: tabRow.implicitHeight + Kirigami.Units.smallSpacing * 2
            color: Kirigami.Theme.alternateBackgroundColor
            visible: !full.chatOpen

            Kirigami.Separator {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
            }

            RowLayout {
                id: tabRow
                anchors.fill: parent
                anchors.topMargin: Kirigami.Units.smallSpacing
                anchors.bottomMargin: Kirigami.Units.smallSpacing
                spacing: 0

                Repeater {
                    model: [
                        { icon: "dialog-messages", label: i18nc("@title:tab", "Chats") },
                        { icon: "view-visible", label: i18nc("@title:tab", "Status") },
                        { icon: "call-start", label: i18nc("@title:tab", "Calls") }
                    ]

                    delegate: PlasmaComponents.AbstractButton {
                        id: tab

                        required property int index
                        required property var modelData

                        readonly property bool current: full.currentTab === tab.index

                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        // The two unbacked tabs are dimmed so the bar reads
                        // honestly at a glance, before anything is clicked.
                        opacity: tab.index === 0 ? 1.0 : 0.5
                        onClicked: full.currentTab = tab.index

                        contentItem: ColumnLayout {
                            id: tabColumn
                            spacing: 0

                            Rectangle {
                                Layout.alignment: Qt.AlignHCenter
                                Layout.preferredWidth: Kirigami.Units.iconSizes.smallMedium
                                    + Kirigami.Units.gridUnit
                                Layout.preferredHeight: Kirigami.Units.iconSizes.smallMedium
                                    + Kirigami.Units.smallSpacing
                                radius: height / 2
                                color: tab.current ? Kirigami.Theme.highlightColor : "transparent"

                                Kirigami.Icon {
                                    anchors.centerIn: parent
                                    width: Kirigami.Units.iconSizes.small
                                    height: width
                                    source: tab.modelData.icon
                                    isMask: true
                                    color: tab.current ? Kirigami.Theme.highlightedTextColor
                                                       : Kirigami.Theme.textColor
                                }
                            }

                            PlasmaComponents.Label {
                                Layout.alignment: Qt.AlignHCenter
                                font: Kirigami.Theme.smallFont
                                color: tab.current ? Kirigami.Theme.highlightColor
                                                   : Kirigami.Theme.textColor
                                text: tab.modelData.label
                            }
                        }
                    }
                }
            }
        }
    }

    // Leaves the search box and drops what was typed. Bound to the chat panel
    // through `filter`, so clearing here clears the list's filter too.
    function stopSearching() {
        full.searching = false;
        searchField.text = "";
    }

    // The header's search box drives the list. Assigned as a binding on the
    // panel rather than read from it, so the panel has no idea a header exists.
    Binding {
        target: chatPanel
        property: "filter"
        value: full.searching ? searchField.text : ""
    }

    // Opening a chat takes the search box away with it; leaving a stale filter
    // armed would silently hide chats on the way back.
    Connections {
        target: chatPanel

        function onActiveJidChanged() {
            if (chatPanel.activeJid !== "") full.stopSearching();
        }
    }

    // A menu is a popup: on some platforms it is its own window and would
    // happily float above the scrim. It holds no message content, but a live
    // control over a censored panel is not something to leave lying around.
    Connections {
        target: root

        function onHiddenChanged() {
            if (root.hidden) overflowMenu.close();
        }
    }

    // One mechanism, one call site's worth of state: `passwordRequired` is
    // assigned here and nowhere else, and is never bound to anything. A
    // binding on top of these writes would break on the first write and then
    // report whatever the gate happened to say the last time it evaluated.
    function refreshGate() {
        hideOverlay.passwordRequired = root.passwordRequired();
        // The gate may have just swapped the Reveal button for the password
        // field under an overlay that is already on screen, which moves no
        // focus by itself.
        hideOverlay.focusPrompt();
    }

    // A popup that closes and reopens does not necessarily toggle the
    // overlay item's `visible`, so re-check on expansion too. Same imperative
    // assignment; no second mechanism, and still nothing that ticks.
    Connections {
        target: root

        function onExpandedChanged() {
            if (root.expanded && root.hidden) full.refreshGate();
        }
    }

    // The full representation is created lazily, so it can come into being
    // with the widget already hidden — in which case `visible` starts out true
    // and never changes, and onShown never fires.
    Component.onCompleted: if (root.hidden) full.refreshGate();

    HideOverlay {
        id: hideOverlay
        anchors.fill: parent
        visible: root.hidden

        onShown: full.refreshGate()

        onRevealRequested: {
            // reveal() re-tests the threshold itself and refuses once it has
            // passed, so an overlay that has been sitting on screen since
            // before the deadline cannot be revealed from a stale decision.
            if (!root.reveal()) full.refreshGate();
        }

        onUnlockRequested: function (password) {
            // The hide this attempt belongs to. A reply that lands after the
            // user hid again must not un-hide the new one.
            const session = root.hiddenSince;
            // `password` goes into the request body and no further: it is not
            // stored, logged, or written to any property that outlives the
            // call.
            full.backend.unlock(password, function (err, data) {
                if (!err) {
                    hideOverlay.reset();
                    if (root.hidden && root.hiddenSince === session) root.revealUnlocked();
                    return;
                }
                // Everything below stays hidden. No branch here reveals, and
                // none of them retries — the backend's backoff is the whole
                // brute-force defence and must not be worked around.
                if (err === 429 || (data && data.reason === "throttled")) {
                    const seconds = (data && data.retryAfterMs > 0)
                        ? Math.ceil(data.retryAfterMs / 1000) : 0;
                    hideOverlay.failed(seconds > 0
                        ? i18nc("@info", "Too many attempts. Try again in %1s.", seconds)
                        : i18nc("@info", "Too many attempts. Try again shortly."));
                } else if (data && data.reason === "invalid") {
                    hideOverlay.failed(i18nc("@info", "Incorrect password."));
                } else {
                    // Backend unreachable, request timed out, refused for some
                    // other reason: the password was never verified, so it is
                    // not an unlock.
                    hideOverlay.failed(i18nc("@info", "Could not verify the password."));
                }
            });
        }
    }
}
