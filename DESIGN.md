# Design language

ScreenVision is the first piece of a larger personal operating system: ScreenVision
is its eyes, Spotlight its main input and output, and an assistant its brain. Every
piece should feel like one product. This document is the shared standard; future
components copy the parts they need and follow the same rules.

## Principles

1. **One voice.** Whenever the assistant has something to say, it says it in the
   same place, the same way: the bubble (below). There are no other pop-ups, toasts
   or menus competing for attention.
2. **Calm, then rich.** Show the least that is useful while the user is acting, and
   the full answer once they pause. Never animate something the user is still moving.
3. **Instant where it can be.** Do expensive work ahead of time (e.g. reading the
   whole screen when the overlay opens) so interactions only filter what is known.
4. **Never lose a capability.** New behaviour adds to old; existing actions (copy,
   search, Lens, QR) stay one click away.
5. **Private by default.** Screen context stays on the computer until the user acts.
6. **Respect the system.** Follow GNOME's dark style, honour "reduce animations",
   work with the keyboard, and keep every string translatable.

## The bubble (`ui/bubble.js`)

The assistant's voice. A floating card that appears next to whatever it talks
about.

### Anatomy

```
╭──────────────────────────────────────────╮
│ Headline: what was understood   •••       │  ← thinking dots, only while working
│ Body: the content itself, streamed in     │
│ word by word.                             │
│ ( Primary action ) ( Action ) ( Action )  │  ← chips; the first is the suggestion
╰──────────────────────────────────────────╯
```

- **Headline:** one short line, sentence case, no trailing full stop. Facts joined
  with " · ", most specific first: `Wi-Fi network “HomeNet” · QR code for example.com`.
- **Body:** the content (recognised text, an answer). At most ~280 characters;
  longer content is shortened at a word boundary with "…" and is always available
  in full through an action (e.g. Copy).
- **Chips:** up to five, ordered by how likely they are wanted. The first is styled
  as primary (blue). Labels are verbs: "Copy", "Open example.com", "Lens".

### States

| State | When | Looks like |
|---|---|---|
| Thinking | Work in progress, nothing to show yet | Headline + slowly pulsing `•••` |
| Moving | The user is still dragging or typing | Headline and chips update instantly; body held back |
| Speaking | The user paused (~400 ms) or let go | Body streams in, each word fading in |
| Confirming | An action succeeded | Headline briefly turns green ("Text copied"), then returns |
| Message | Something to say with no subject | Bubble above the toolbar, fades out after ~2 s |

### Motion

| What | Timing |
|---|---|
| Appear / disappear | 180 ms, ease-out, opacity plus scale 0.97 → 1 |
| Word stream | a word starts every 28 ms (whole message capped at ~1.6 s) and fades in over 220 ms |
| Thinking pulse | 600 ms per breath, ease-in-out |
| Confirmation | 1.4 s |

With animations turned off in GNOME, everything appears immediately.

### Placement

Below the subject if there is room, then above, then to the right, then to the
left, always clear of toolbars and screen edges. Never covers the user's
selection.

### Look

Translucent dark card (`rgba(30,31,36,0.78)`) with a background blur, 18 px
corners, a hairline light border and a soft shadow. Maximum width 440 px. Text
`#f5f5f7`; primary chip blue `rgba(10,132,255,0.85)`. Styles live in
`stylesheet.css` under `.sv-bubble*`.

### API

```js
bubble.think('Reading the screen');                      // thinking state
bubble.say({headline: '1 line of text', body: text});    // speak, body streams in
bubble.stream(moreText);                                 // append (e.g. model tokens)
bubble.setActions([{label: 'Copy', onActivate}]);        // chips
bubble.flash('Text copied');                             // confirmation
bubble.placeNear(rect, avoidRect);                       // position
bubble.show(); bubble.hide();
```

`stream()` exists for the assistant: when a language model answers, its tokens
are passed straight to `stream()` and appear exactly like today's text.

## The pill (`ui/pill.js`)

The overlay's only fixed controls, centred at the bottom of the primary
monitor, in the same glass style as the bubble:

```
╭────────────────────────────────────────────────────────────────╮
│ ⤢ Whole screen   Drag to select · ↵ Remember · Esc to close   ✕ │
╰────────────────────────────────────────────────────────────────╯
```

- Holds only what cannot live in the bubble. Everything about *what* is selected
  belongs in the bubble.
- Fades to low opacity when the selection runs underneath it, so the user's work
  is never covered.

## Live Text selection

Recognised words can be selected like text in a document, as in Apple's Live Text:

- Over a recognised word the pointer becomes an I-beam. Pressing there and dragging
  selects words in reading order; double-click selects a word, triple-click a line.
  Pressing anywhere else (or on the area's edges and handles, or with Ctrl) draws or
  moves the area as before.
- Selected words are drawn as one rounded bar per line in system blue
  (`rgba(10, 132, 255, 0.38)`), on top of the usual word boxes.
- While words are selected they are the subject: the bubble says "2 words selected"
  and every action (Remember, Copy, Search, Lens, Ctrl+C) uses them.
- Esc clears the text selection first; a second Esc closes.
- Selecting never touches the clipboard; only Copy / Ctrl+C do.

## Keys

Enter always does what the first (blue) chip does: **Remember**. Ctrl+C copies.
Esc closes. Keep this consistent everywhere: the primary chip and Enter are the
same action.

## Writing style

- Plain words, no jargon, no exclamation marks.
- Describe, don't narrate yourself: "1 line of text", not "I found 1 line of text".
- Problems say what to do: "Install zbar (zbarimg) to scan QR codes".

## Sharing across components

Until a shared design package exists in the umbrella repository, components copy
`ui/bubble.js`, `ui/textReveal.js` and the `.sv-bubble*` styles, and keep them in
sync with this document.
