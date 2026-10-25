# Where kiwi-shell differs from macOS

Desktops, Mission Control, their gestures and the island, as of October
2026. Remove a line once kiwi matches macOS there.

## Gestures

- Desktops and Mission Control are on three fingers. Apple documents four
  (three "in some versions of macOS"); four would collide with kiwi's
  Notification Center swipe.
- Notification Center opens with four fingers left and closes with four
  fingers right. macOS uses two fingers from the trackpad's right edge;
  libinput reports two fingers as scrolling, with no position, so an edge
  swipe can't be told apart.
- Notification Center comes once the fingers have gone a little way. On macOS
  it follows the fingers in.
- Three fingers down outside Mission Control does nothing. On macOS it opens
  App Exposé.
- Swiping past the first or last desktop stops dead. macOS lets the screen go
  a little way and springs back.

## Mission Control

- Only the display with the focused window enters Mission Control. macOS
  shows it on every display at once.
- The Dock is covered. macOS keeps it visible and usable.
- Clicking the desktop already in view flies its windows home. macOS zooms
  into its picture as it does into any other desktop's.
- Pressing a desktop's picture doesn't darken it. macOS darkens it to about
  half until the button comes up.
- Holding Option doesn't show every desktop's ×.
- + is a disc that stays where it is; pointed at, it brightens and the new
  desktop slides in under it. macOS draws a bare + that takes a shape only
  while pointed at.
- The title of the window under the pointer is a dark pill under the
  window. macOS centres a light pill with dark text on the window itself.
- Windows keep their title bars (hyprbars', or another plugin's) in Mission
  Control and in flight, as on a Mac; in the desktops' small pictures at the
  top they are drawn without them.
- While the windows move (the bar opening, desktops closing), their shadows
  can be a frame ahead of their pictures: the compositor takes the pictures'
  new places with the frame after.
- There is no App Exposé (Control+Down).
- A window dragged in Mission Control is its last frame while it is
  carried, not live; macOS keeps it live.

## Desktops

- The island in the bar can show the display's desktops, one mark each in
  Mission Control's order. macOS has nothing in the menu bar for desktops.
- Super+1–0 in the default Hyprland config go to workspace ids, not to the
  nth desktop of the display.

## Windows

- Hyprland's tiling stays: tiled and floating windows stack in one order,
  the one brought forward on top, as every window on a Mac does. Hyprland
  alone keeps tiled windows under floating ones.
- On a desktop with tiled windows, a window dragged against the left or
  right edge joins the tiling, halving the tile at that edge, and one dragged
  into a corner takes the top or bottom of the tile there. macOS gives it
  exactly that half or quarter of the screen, whatever else is on it. On a
  desktop with no tiled windows kiwi does as macOS does.
- After a window is snapped to a half, the desktop's other windows are
  offered for the other half, one click putting one there. macOS offers them
  this way only in Split View, Windows (Snap Assist) after any snap.
- A tiled window dragged with a modifier held (Hyprland's own move) moves
  within the tiling. macOS has no tiling; dragged by its title bar, a tiled
  window comes out of it, at its own size, as a tiled Mac window does.

## Island

The middle of the bar is iPhone's Dynamic Island, in iOS's rules (Apple's
Human Interface Guidelines, Live Activities). macOS has no island: it shows
Now Playing, the privacy indicators and, since Tahoe, the iPhone's Live
Activities as menu bar items.

- At rest it shows the desktops, the date or the weather. The date opens a
  calendar, as the classic desktops' clocks do; macOS keeps a calendar in
  Notification Center.
- With several activities, the first keeps its two halves either side of the
  middle and the next two are bubbles beside the island. iOS makes the first
  one minimal too, to save a phone's width.
- Alerts (a charger plugged in, a Bluetooth device connected, Do Not Disturb)
  show either side of the middle for a few seconds. iOS grows the island into
  them; macOS shows none of them and chimes for the charger.
- Memory running out, a hot CPU and a busy CPU are activities. A Mac shows
  these only in Activity Monitor.
- The CPU is an activity only at its limit (95% of all its cores for a
  minute); opening its card keeps it out of the island until that's over. A
  Mac never says. The cards are a small Activity Monitor, live while open,
  an app with a window quit from its row.
- Apps using significant energy are listed in the system menu's Performance
  tab; a Mac lists them in its battery menu, which kiwi doesn't have. kiwi
  goes by CPU time alone; macOS's energy counts the GPU, wake-ups and the
  disk too.
- The privacy indicators are icons in their colours (camera, microphone,
  screen), not iOS's dots, which are a phone's lack of room: after a line at
  the island's end, or in a bubble of their own beside it while it shows
  something else. macOS shows them in the menu bar.
- The camera indicator sees apps using the camera through PipeWire and ones
  opening its device themselves, the user's own processes. macOS sees every
  app.
- The weather is Open-Meteo's, for a city set in the settings. macOS's comes
  from Apple Weather, for where the Mac is.
- The island is the bar's glass, like the other pills. iOS's is black, as
  the camera it sits around is.
- The motion is springs chosen by eye (the island's size: response 0.5 s,
  bounce 0.25), not measured off an iPhone.

## App switcher

- kiwi's Alt+Tab shows a picture of every window with its title under it,
  the chosen picture outlined in the accent colour. macOS's Command+Tab shows
  one icon per app, the chosen one on a lighter rounded square, its name
  under the row.

## Measured against macOS

From "How to Use Mission Control on Mac (Master Multiple Desktops)"
(youtube.com/watch?v=FVj2SdDuW9g, 1080p at 60 fps), frame by frame:

- Switching desktops with Control+arrow: the screen moves sideways as one,
  with a gap of 3.3% of its width between desktops, on a spring 50% there
  after ~140 ms, 90% after 300 ms, 99% after 450 ms — ω ≈ 12/s, damping
  ratio ≈ 0.9. kiwi's slide, measured the same way: 133 / 283 / 433 ms,
  ω 12.0, ζ 0.90.
- The video's recorder (Screen Studio) zooms the picture during most of the
  Mission Control demonstrations, so those can't be timed from it.

From MacMost's "31 Mission Control Tips" (youtube.com/watch?v=vj4tYfGnezg,
1080p at 30 fps), one window tracked by its image features through three
openings and a closing:

- Mission Control opening and closing alike: the windows go between their
  places and the spread on cubic-bezier(0.35, 0, 0.65, 1) over 240 ms (within
  1%) — slow off the mark, steady through the middle, settling at the end:
  50% there after 133–167 ms, 90% after 200–233 ms (30 fps, ±17 ms). kiwi
  uses that curve; filmed at 60 fps and tracked the same way: 133 / 199 ms,
  done by 232 ms.
- The windows stay live: what they draw goes on showing in Mission Control.

From MacMost's "Learn How To Use Mission Control In 5 Minutes"
(youtube.com/watch?v=6QwTtQl0ab0, macOS 26) and the video above, frame by
frame; kiwi does each of these the same way (widgets/MissionControl/motion.ts):

- Opening: the wallpaper isn't darkened; the menu bar fades out and the
  desktops' names come down from above the screen as the windows fly.
- The bar opening, once the pointer is at the top: its band grows from a
  strip of names to the height of the desktops' pictures, which come down
  from above the screen; the names go down to be their captions, and the
  windows move down by as much, keeping their size — all in about 200 ms,
  ease-in-out. It doesn't fold up again until Mission Control closes.
- Control+arrow in Mission Control: the wallpaper and the windows slide
  sideways as one, on the desktops' spring, with a dark gap of 5% of the
  width; the bar stays, and the accent ring jumps to the new desktop at once.
- +: pointed at, a new desktop peeks in at the bar's end, about 63 of 1440
  pixels of it with + on it (200 ms, ease-out); clicked, it slides to its
  place as the others make room, on cubic-bezier(0.4, 0, 0.6, 1) over 950 ms.
- ×: the desktop goes at once; the others close up on cubic-bezier(0.25, 0,
  0.2, 1) over 260 ms; its windows, when they come to the desktop in view,
  fly out of its picture into their places on the windows' curve. The × is
  a light grey disc with a dark grey cross, there as soon as the pointer is
  on the desktop.
- A desktop clicked: its picture grows from its place in the bar to fill the
  display, over Mission Control, on the windows' curve in 240 ms, and that
  desktop is there.
- A window pointed at gets its outline (about 4 px, close round it) and
  title at once, nothing fading in.
