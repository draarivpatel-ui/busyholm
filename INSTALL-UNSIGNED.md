# Installing Busyholm on your Mac

Busyholm is free, but it is not signed with an Apple Developer ID or checked (notarized) by Apple. That costs a paid
Apple developer membership, which Busyholm does not have yet. Because of that, the first time you open it your Mac
shows a warning and will not open it until you say it is OK. This guide shows you how, step by step.

You only have to do this once. After that, Busyholm opens with a normal double-click.

## Before you start

1. Check that your Mac has Apple silicon. Click the Apple menu in the top left corner of the screen and choose
   About This Mac. If you see a line called **Chip** (for example "Apple M2"), you are fine. If you see a line called
   **Processor** with an Intel name instead, this version of Busyholm will not run on your Mac.
2. Check your macOS version on the same About This Mac window. Busyholm needs macOS 11 Big Sur or later.
3. Download Busyholm only from its official GitHub release page (github.com/draarivpatel-ui/busyholm, under
   Releases). Apple warns that skipping its security check is the most common way a Mac gets malware, so only do it
   for a file you got from the official page.

## Step 1: download

Pick one:

- **The DMG** (`Busyholm-0.1.1.dmg`), recommended.
- **The zip** (`Busyholm-0.1.1.app.zip`), if the DMG gives you trouble.

Your browser saves it in your Downloads folder.

Optional, for people comfortable with Terminal: the release also has a `SHA256SUMS` file. In Terminal, run
`shasum -a 256 ~/Downloads/Busyholm-0.1.1.dmg` (or `shasum -a 256 ~/Downloads/Busyholm-0.1.1.app.zip` if you got the
zip) and check that the long code it prints matches the line for that file in `SHA256SUMS`. If it does not match,
delete the download and do not open it.

## Step 2: put Busyholm in Applications

If you downloaded the DMG:

1. Double-click `Busyholm-0.1.1.dmg` in Downloads. A window opens with the Busyholm icon and an Applications folder.
2. Drag the Busyholm icon onto the Applications folder.
3. Close the window, then eject the disk: in the Finder sidebar, click the eject button next to the Busyholm disk.

If you downloaded the zip:

1. Double-click `Busyholm-0.1.1.app.zip` in Downloads. Your Mac unpacks it into `Busyholm.app` next to it.
2. Drag `Busyholm.app` into the Applications folder (in the Finder sidebar).

## Step 3: open it the first time

The steps depend on your macOS version (it is on the About This Mac window).

### macOS 15 Sequoia or later (including macOS 26 Tahoe and macOS 27)

On these versions, right-clicking the app and choosing Open no longer gets you past the warning. You use System
Settings instead.

1. Open the Applications folder and double-click **Busyholm**.
2. A warning appears saying macOS cannot check Busyholm (the exact words change between versions). Click **Done**.
   Do not click Move to Trash.
3. Click the Apple menu and choose **System Settings**.
4. Click **Privacy & Security** in the sidebar. You may need to scroll down in the sidebar to find it.
5. Scroll down the right side to the **Security** section. You will see a line saying Busyholm was blocked. Click
   the button next to it (Apple's guide calls it **Open**; on some versions it reads **Open Anyway**).
6. If a box asks you to confirm, click **Open Anyway**.
7. Type your Mac's login password (the one you use to unlock your Mac) and click **OK**.
8. If the warning about Busyholm shows up again, click **Open**.

Busyholm now opens. From now on you can open it with a normal double-click.

The button in step 5 only appears for about an hour after you tried to open the app. If you do not see it, go back to
step 1 and try opening Busyholm again, then come back to Privacy & Security.

### macOS 11 Big Sur to macOS 14 Sonoma

1. Open the Applications folder in Finder. (Use Finder, not Launchpad: Launchpad does not show the menu you need.)
2. Hold the **Control** key and click **Busyholm** (or right-click it).
3. Choose **Open** from the menu.
4. In the warning that appears, click **Open**.

Busyholm now opens. From now on you can open it with a normal double-click.

If that does not work, you can also use the settings route: on macOS 13 and 14 go to System Settings, then Privacy &
Security, and click **Open Anyway**; on macOS 11 and 12 go to System Preferences, then Security & Privacy, the General
tab, and click **Open Anyway**. That button appears for about an hour after you tried to open the app.

## Step 4: first-run setup

When Busyholm opens for the first time it shows a short setup:

1. It explains what it reads and what it never keeps.
2. You choose what to connect: Claude Code, Codex, and (optionally) the Claude Code status line for the usage sky.
3. It shows you the exact changes it will make to those tools' settings files. Nothing changes until you confirm.
4. If you connected Codex, Codex asks you once to approve the new hooks (with `/hooks` in Codex).
5. You choose where the island strip sits, and you are done.

You can change any of this later in Settings, and Disconnect all removes every change Busyholm made.

## If something goes wrong

- **"Busyholm is damaged and can't be opened."** This is a different message from the normal warning. It means
  macOS thinks the file was changed or broken. Do not try to force it open. Move it to the Trash, download it again
  from the official release page, and if the checksum step above is easy for you, check it.
- **I clicked Move to Trash by mistake.** Take Busyholm out of the Trash (or download it again), put it back in
  Applications, and start Step 3 again.
- **I cannot find the Open Anyway button.** It only shows for about an hour after you try to open the app. Double-click
  Busyholm again, then go straight to System Settings, Privacy & Security (on macOS 11 and 12: System Preferences,
  Security & Privacy, the General tab). If it still is not there, the Mac may be managed by a school or workplace
  that blocks this setting; ask whoever manages it.
- **The Mac asks for an administrator's name and password.** Ask the person who manages the Mac to type it in.

## Removing Busyholm

1. Open Busyholm's Settings and choose **Delete everything**. It disconnects Busyholm from Claude Code and Codex,
   turns off Open at login, removes Busyholm's own files and closes the app.
2. Drag Busyholm from Applications to the Trash.

## Where these steps come from

Checked against Apple's own support pages on 2 November 2026:

- "Open a Mac app from an unknown developer", Mac User Guide (current version, and the macOS 15, 14, 13 and 11
  versions): https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac
  The current page says: choose Apple menu, System Settings, then Privacy & Security; "Go to Security, then click
  Open"; "Click Open Anyway. This button is available for about an hour after you try to open the app"; then enter
  your login password and click OK. The macOS 11, 13 and 14 versions of the page give the Control-click, Open route, with Open Anyway as the other way.
  The macOS 15 and later versions no longer mention it.
- "Safely open apps on your Mac" (published 27 May 2026): https://support.apple.com/en-us/102445
  It says to open System Settings, click Privacy & Security, scroll down and click Open Anyway, and that "the warning
  prompt reappears" and you can then click Open. Its example warning reads "Apple cannot check 'Example App' for
  malicious software" with Move to Trash and Done buttons.
- "Mac computers with Apple silicon" (published 12 May 2026): https://support.apple.com/en-us/116943
  It says About This Mac shows **Chip** on a Mac with Apple silicon and **Processor** on an Intel Mac.

Apple's button labels can shift a
little between macOS updates; if yours differ, follow the closest match.
