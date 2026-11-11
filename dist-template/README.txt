AI Limits - desktop widget
=========================

Shows how much of your Claude, Codex, Antigravity and DeepSeek Harness
allowances you have left, on the macOS desktop, plus a phone view.

Requirements
------------
  * macOS 14 (Sonoma) or newer, Apple Silicon or Intel
  * Python 3 - install with:  xcode-select --install
  * Optional:  pip3 install --user zstandard   (enables DeepSeek session titles)
  * At least one of these apps installed and SIGNED IN, because the widget
    reads the session each app already keeps on this Mac:
        Claude Desktop, ChatGPT (Codex), Antigravity, DeepSeek Harness

Install
-------
  1. Unzip this folder somewhere (Downloads is fine).
  2. Open Terminal, then:

         cd ~/Downloads/AI-Limits
         bash install.sh

     For internet access as well (public HTTPS URL):

         bash install.sh --tunnel

  3. The card appears on the desktop. Open your wallpaper (Show Desktop)
     if windows cover it; drag it anywhere; right-click for options.

First launch: macOS asks for Keychain access twice
---------------------------------------------------
  "Claude Safe Storage" and the Antigravity key. Choose ALWAYS ALLOW.
  The widget only decrypts the token your own apps already stored, and it
  caches what it needs in ~/.limitswidget (mode 0600). Nothing is uploaded.

Phone
-----
  The installer prints a LAN URL like:
      http://Your-Mac.local:8787/t/<token>/
  Open it on a phone on the same Wi-Fi, then Share -> Add to Home Screen.

  With --tunnel the same page is also reachable from anywhere; the public
  URL appears in ~/.limitswidget/cloudflared.log about 15 seconds after
  install (it changes whenever the tunnel restarts). Treat that link like a
  password - it is protected only by the token in the path.

Remove it
---------
  launchctl bootout gui/$(id -u)/com.sai.ailimits
  launchctl bootout gui/$(id -u)/com.sai.ailimits.web
  launchctl bootout gui/$(id -u)/com.sai.ailimits.tunnel   # if installed
  rm -rf "$HOME/Applications/AI Limits.app" "$HOME/Library/LaunchAgents"/com.sai.ailimits*.plist "$HOME/.limitswidget"
