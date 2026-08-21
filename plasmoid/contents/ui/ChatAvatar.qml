import QtQuick
import org.kde.kirigami as Kirigami

/**
 * The stand-in for a profile picture: the chat's initial on a coloured disc.
 *
 * There are no avatars in this system. The backend's chat records are exactly
 * {jid, name, unread, lastMessageAt, lastMessageText, lastMessageFromMe} —
 * no picture, no URL, nothing to fetch one with. Fetching them would mean new
 * backend work *and* pulling personal images of the user's contacts onto disk
 * for a decoration, which is not a trade this widget makes. So the disc is
 * generated, never downloaded.
 *
 * The colour is a pure function of the JID, so a chat keeps the same disc for
 * as long as it exists and across restarts, and two chats do not swap colours
 * when the list reorders.
 */
Rectangle {
    id: avatar

    required property string jid
    required property string name

    /**
     * A stable 31-based string hash of the JID. `| 0` keeps it in int32 so a
     * long JID cannot drift into the range where doubles stop being exact and
     * the "same JID, same colour" promise quietly breaks.
     */
    readonly property int hash: {
        var h = 0;
        for (var i = 0; i < avatar.jid.length; ++i) {
            h = (h * 31 + avatar.jid.charCodeAt(i)) | 0;
        }
        return Math.abs(h);
    }

    /**
     * The first *character* of the name — by code point, so a name starting
     * with an emoji or any other astral character yields that character and
     * not the lone surrogate half that charAt(0) would return.
     */
    readonly property string initial: {
        var source = avatar.name.trim().length > 0 ? avatar.name.trim() : avatar.jid;
        if (source.length === 0) return "?";
        return String.fromCodePoint(source.codePointAt(0)).toUpperCase();
    }

    radius: width / 2

    // Spread around the colour scheme's accent hue rather than over the whole
    // wheel: the discs stay a family that belongs to the user's theme (violet
    // here, blue on stock Breeze) instead of a fruit salad that fights it.
    //
    // Saturation and lightness are fixed rather than taken from a theme role
    // because they are doing legibility work, not decoration: this is the
    // background of white text, and a role can be any lightness at all. A
    // greyscale accent has no hue (hslHue reports -1), in which case the
    // discs fall back to spanning the full wheel.
    color: {
        const accentHue = Kirigami.Theme.highlightColor.hslHue;
        const spread = accentHue < 0 ? 360 : 120;
        const centre = accentHue < 0 ? 0 : accentHue * 360;
        const hue = (((centre + (avatar.hash % spread) - spread / 2) % 360) + 360) % 360;
        return Qt.hsla(hue / 360, 0.45, 0.52, 1.0);
    }

    Text {
        anchors.centerIn: parent
        text: avatar.initial
        // White, not Theme.textColor: the disc behind it is a mid-lightness
        // colour of our own choosing, and the scheme's text colour is black
        // on a light theme — which would be the unreadable half of the pair.
        color: "white"
        font.family: Kirigami.Theme.defaultFont.family
        font.bold: true
        font.pixelSize: Math.round(avatar.height * 0.44)
    }
}
