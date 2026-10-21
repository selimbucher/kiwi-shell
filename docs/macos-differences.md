# Where kiwi-shell differs from macOS

Desktops, Mission Control and their gestures, as of October 2026. Remove a
line once kiwi matches macOS there.

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
- The title of the window under the pointer is a dark pill under the
  window. macOS centres a light pill with dark text on the window itself.
- Windows in flight, and in the desktops' pictures, are drawn without their
  title bars, which appear once they have landed.
- While the windows move (the bar opening, desktops closing), their shadows
  can be a frame ahead of their pictures: the compositor takes the pictures'
  new places with the frame after.
- There is no App Exposé (Control+Down).

## Desktops

- The bar shows numbered workspace dots. macOS has nothing in the menu bar
  for desktops.
- Super+1–0 in the default Hyprland config go to workspace ids, not to the
  nth desktop of the display.

## App switcher

- kiwi's Alt+Tab shows a picture of every window, the chosen one outlined in
  the accent colour. macOS's Command+Tab shows one icon per app, the chosen
  one on a lighter rounded square, its name under the row.

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
