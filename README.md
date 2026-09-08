# PRCY Manager

A desktop library for games you downloaded yourself — itch.io bundles, jam builds,
loose zips you extracted somewhere. It scans folders you point it at, figures out
which executable to run, tracks how long you play, and keeps a password-protected
section for titles you would rather not have on screen.

## Running it

```bash
npm install
npm run dev     # development, with hot reload
npm run build   # production build into out/
npm start       # run the production build
npm run dist    # package a Windows installer into dist/
npm run icon    # regenerate build/icon.ico from scripts/make-icon.mjs
```

## How it works

**Libraries.** Add one or more *library folders* — a folder whose direct
subfolders include your games (`D:\Games\Cave Diver\`, `E:\itch\Neon Drift\`).
It does not have to hold only games: a root can be a general download or storage
folder with pictures, music and documents beside them, since anything without a
program inside is skipped. You can add as many roots as you like across as many
drives as you like. A drive that
is unplugged at scan time is reported as offline and its games are left alone
rather than marked missing. Games that live somewhere odd can be added one at a
time with **Add single game**.

**Non-games are filtered out.** A library root usually holds more than games.
Four rules keep the rest out: name patterns for online fixes and repair packages
(`*_Fix_Repair_Steam_Generic`) and crack folders; name patterns for installers
and repacks (`[FitGirl Repack]`, `DODI`, `setup`), which hold a setup program
rather than a playable game; a list of support-folder names plus Unity's `*_Data`
suffix, for engine leftovers such as `Engine` and `_CommonRedist` when an archive
was extracted into the root instead of its own folder; and finally, a folder with
nothing runnable inside is not a game — which is what lets a root double as a
general storage folder full of pictures, music and documents.

An Unreal project directory (a `Binaries`/`Content` pair) counts as leftovers
only when an `Engine` folder sits beside it, since that same shape is also a
normal game root. The scan result names the folders it skipped, so a wrong guess
is visible rather than silent. An entry already in your library that now matches
is removed only if it is untouched — no playtime, favourite, tags, notes or vault
flag — so nothing you invested in disappears. The filter runs on root children
only, so **Add single game** always wins if it ever guesses wrong.

**Wrappers and containers.** A downloaded game is often wrapped in a second
folder of its own name (a double-extracted zip), and people keep several games
together inside one folder. Naming either after the outer folder gets it wrong,
so a root child with no content of its own — only subfolders, plus incidental
files like a readme or a link — is opened up: each subfolder that has something
runnable becomes its own game, named after the folder the game actually lives in.
`Don't show/RJ01095162-NTRKnight-v1.02/RJ01095162-NTRKnight-v1.02/Game.exe`
becomes one game called *NTRKnight*, and `Little-Nightmares-SteamRIP.com/Little
Nightmares/` becomes *Little Nightmares*. An Unreal project directory is never
opened up this way, or a game would end up named after its `Atlas` folder.

When a folder that was already in your library turns out to be a wrapper, its
entry is retired rather than left sitting beside its replacement as a duplicate,
and what you had set on it moves across: playtime, favourite, tags, notes, a
title you typed, and — importantly — whether it was in the vault. A folder that
held several games passes its vault flag to all of them, since a folder hidden on
purpose must not reappear in pieces.

**Titles.** The folder name is cleaned of the things downloads carry and games do
not: platform tags (`-win64`, `-pc`), versions (`v1.02`, `0.33.0.2free`), release
groups and sites (`-OFME`, `-SteamRIP.com`), build tags (`Hotfix 2`), and store
codes (`RJ01095162-`). Titles are always editable in the detail panel.

Two copies of one game are both kept — a second copy is usually a different
build, not a mistake — so instead of dropping one, colliding titles are told
apart by whatever distinguishes them on disk: *How to Fish (v1.0.10)* and *How to
Fish (v1.0.2)*, or *CoDBOIII* and *CoDBOIII (C0D Black O3)*. Only a title still
matching what the scanner generated is qualified, so a name you typed is never
rewritten, and rescanning does not stack qualifiers.

**Executable detection.** Each game folder is searched five levels deep for
`.exe`, `.bat`, `.cmd`, `.lnk`, `.jar`, `.swf` and `.html`. Candidates are ranked
by name similarity to the folder, depth, file size and extension; uninstallers,
redistributables and crash handlers are pushed to the bottom. The best guess is
selected automatically, and every candidate stays listed in the detail panel so
you can switch with one click. A choice you make by hand is never overwritten by
a later scan.

**Playtime.** Launching spawns the executable and times it. Because many games
are a small launcher that starts the real binary and exits, the app keeps
watching the Windows process list for the same image name after the child exits.
Sessions shorter than the configured threshold (10 s by default) are discarded so
a mis-launch does not pollute your stats. If a timer ever gets stuck, **Mark as
closed** in the detail panel ends it.

**Cover art.** Each game's detail panel has **Find online…**, which searches
Steam's own store API — no account or key needed — plus SteamGridDB if you paste
a free key into Settings. (Steam's API, not steamdb.info: the latter is a
third-party mirror behind Cloudflare, and Steam serves the same artwork
directly.) Both the portrait library capsule and the landscape header are offered
per game; not every app has a portrait one, so any tile whose image fails to load
is dropped from the picker rather than shown broken, and applying falls back
portrait → thumbnail → header. Chosen art is downloaded into `covers/` beside
your library file, so it survives the game folder being moved or re-extracted.

Settings has **Fetch missing covers** for a whole-library pass. It only applies
art when the result's title is a close match (0.72 similarity or better) and
skips the rest rather than guessing, and it paces itself at roughly one request a
second. Because covers arrive in both shapes, a card shows the whole image over a
blurred copy of itself instead of cropping portrait art to a landscape tile.

**Storage.** The **Storage** screen is about this machine's disks, not the
server. It measures each game folder once and remembers the size, then shows a
bar per drive — how much of it your games are, how much is everything else, how
much is free — followed by every game biggest first, with a **Never played**
filter for the ones that cost the most and gave the least. Deleting from here
sends the folder to the Recycle Bin rather than unlinking it, because this is
the one action in the app that destroys something you cannot get back in a
minute. The app's own files are listed too, with one button to drop cover images
no game points at any more and another to thin save backups older than a month.

Sizes are deliberately local. They are never sent to the sync server and never
stamp the merge clock, so measuring on the laptop does not look like an edit to
the desktop, and freeing space on one machine leaves the others alone.

**Hidden vault.** Hiding a game requires setting a vault password first. Hidden
games are filtered out in the main process, so a locked vault means the renderer
never receives them at all — they cannot appear in search, counts or any filter.
The password is stored only as a PBKDF2-SHA512 hash (210k iterations, random
salt); it cannot be recovered if forgotten. The vault relocks when the app
closes. Note this hides titles *inside the app* — the game folders themselves are
untouched and still visible in Explorer.

**Cross-device sync.** `server/` holds a self-hosted sync server — one
dependency-free file meant for a home server such as Unraid. Point every device
at it (**Settings → Cross-device sync**) and they share game saves, playtime,
favourites, tags, notes, cover art and the hidden vault. See `server/README.md`
for running it.

One server can hold several accounts. Each has its own library, saves and vault,
and sees nothing of the others; only the cover-art store is shared, since it is
content-addressed public artwork. A device signs in once with a username and
password and keeps a token of its own, so signing one device out leaves the rest
alone. Sign-ups need an invite code the server owner sets, or the owner adds
accounts with an admin token that cannot read anybody's library.

Games are paired across devices by title, so the same game named slightly
differently on two machines would sit as two entries and never share a save.
After a sync, near misses are offered rather than applied: *Cave Diver Complete*
here, *Cave Diver* on the desktop, 64% alike, and one of them has a save
waiting. Accepting adopts the other device's name, and optionally renames the
folder on disk so a later scan produces that name by itself — the executable,
cover and any absolute save paths follow it, and the entry the old name left on
the server is cleaned up on the next sync. Titles are compared after the same
cleanup the scanner uses, so `Abyssus.v1.3.62055-OFME` matches *Abyssus*, while
a differing number on the end keeps *Portal* and *Portal 2* apart.

The server has a small web console at its own address: sign in with the admin
token to see what it holds, add or remove accounts, and update the server in
place. An update replaces only the server's own code — the new version is booted
against a throwaway directory and has to answer before it is installed, the
previous one stays on disk to step back to, and a supervisor rolls back by
itself if a version starts failing. Saves and accounts are never touched by it.

Anything larger than one request's worth is uploaded in chunks and reassembled
on the server. That is not an optimisation: proxies cap request bodies —
Cloudflare refuses anything over 100 MB below its Enterprise plan — and a big
save set would otherwise be undeliverable from outside the house. The server
advertises its own limit and the app splits to match.

Saves are the interesting half. Each game gets its save locations set on its
detail panel — **Find saves** looks in the places Windows games actually use
(`%APPDATA%`, `%LOCALAPPDATA%`, LocalLow, `Documents\My Games`, `Saved Games`,
Ren'Py, Godot, and save folders inside the game itself), and you can add any
folder by hand. Locations are stored as tokens like `{APPDATA}/RenPy/Game`, so
they expand to the right folder on each machine. A location that cannot be
tokenised is device-specific and is deliberately never shared, so one PC can
never point another at a path that means something different there.

A save set travels as a single gzipped archive whose entries are relative to
their location, which is what makes it portable between machines with different
usernames. Sync compares content hashes, so unchanged saves are not re-uploaded.
If both devices played since the last sync, you are asked which version to keep.
The prompt is built to be answerable: it says which side was written more
recently and by how much, gives the file count and total size of each, and lists
the files themselves newest first — size and modification time side by side, with
"missing" where one device has a file the other does not. That is the honest
limit of what generic tooling can tell you about progress, and in practice the
newest slot file plus a bigger save is enough. The other version stays on the
server *and* in a local `save-backups` folder, so nothing is destroyed by a
wrong answer. Playtime is tracked per device and
summed, so two machines never overwrite each other's hours, and everything else
merges by whichever device was edited last.

**Updating the app.** The desktop app updates itself from the same server that
holds the saves — every device that syncs is already signed in to it and can
reach it, so nothing has to be published anywhere public. Build an installer
with `npm run dist`, then put it on the server:

```bash
PRCY_URL=http://tower.local:8787 PRCY_ADMIN_TOKEN=… npm run publish
```

The console can also mint a no-account **share link** for the newest build — an
unguessable path that serves the installer to someone who does not have the app
yet and so cannot sign in to get it. Revocable from the same place. Setting
`PRCY_PUBLIC_PORT` opens a second listener that serves *only* those links, so
that port can face the internet while the console, the API and every save stay
on the private one.

It uploads in chunks like a save does, and only the admin token may publish — a
signed-in account is refused. Each device sees the new version under
**Settings → App updates**, downloads it, checks it against the SHA-256 the
server recorded, and refuses to run anything that does not match. Installing
closes the app so Windows can replace its files. The server keeps the three most
recent builds.

## Layout

```
src/
  main/       Electron main process
    index.ts    window, gameimg:// protocol for cover art
    store.ts    JSON library in userData, atomic writes
    scanner.ts  folder walking, exe ranking, title cleanup
    launcher.ts spawning and playtime sessions
    vault.ts    password hashing, lock state
    covers.ts   Steam / SteamGridDB art search and download
    appupdate.ts checks, downloads and verifies a new build from the server
    storage.ts  folder sizes, drive usage, deleting to the Recycle Bin
    sync.ts     cross-device merge, save upload/download, conflicts
    savepaths.ts save-location detection and portable path tokens
    archive.ts  the save archive container (no zip dependency)
    ipc.ts      every renderer-facing handler
  preload/    contextBridge API surface
  renderer/   React UI
  shared/     types used by both sides
server/
  swag/           a ready SWAG proxy conf for the downloads-only port
scripts/
  make-icon.mjs   renders the app mark to build/icon.ico (no image deps)
  publish-app.mjs uploads a built installer to your sync server
```

Your library lives in a single JSON file under Electron's `userData` directory —
**Settings → Data** shows the exact path.
