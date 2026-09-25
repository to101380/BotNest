# BotNest visual and motion language

The user's preferred direction is a restrained Apple-inspired interface: simplify the visible controls and copy, let a shared white selection pill slide between options, transition content with short directional movement, and use translucent frosted surfaces. Treat this as the default for future UI work.

- Keep the BotNest identity, system fonts, white/gray canvas, dark readable text, and blue primary actions.
- Use one moving selection surface per group. AI tabs, sign-in/register, workspace navigation and conversation AI modes share the same indicator implementation. Preserve keyboard behavior and existing selection semantics.
- Use 160 ms for control feedback, 300 ms for content, and 380 ms for the selection pill and side drawer. Ease out gently; rapid repeated actions must retarget from the current visible position, without queuing or delaying actions.
- Apply glass to navigation, sticky toolbars, composers, dialogs and floating panels. Use translucent card fills and subtle borders. Keep text and form controls legible; avoid decorative gradients, excessive blur on every element, and looping decorative movement.
- Slide the customer drawer in and out. Closed drawers must be inert. Keep details as native expandable controls, with smooth height transitions where supported.
- Honor reduced-motion, reduced-transparency and forced-color preferences. Browsers lacking motion support must retain working static controls. Do not animate history insertion or background data refreshes, which would disrupt reading and scroll anchoring.

Implementation: `public/minimal-ui.css` establishes layout and typography; `public/ui-motion.css` and `public/ui-motion.js` add material and movement without changing business state or requests.

Deploy from a fresh production snapshot, preserving unrelated local work and Firebase configuration. See `UI_SIMPLIFICATION_20260926.md` for the isolation workflow.

## Motion release — 2026-09-26

Published Hosting version `b7aea3c1502886b1` to `planning-with-ai-52d58`. The isolated `.deploy-cost/motion` release changed only `index.html` and the two new motion files. All published assets were compared with the staged files after deployment.

Validation: 38 JavaScript syntax checks and 121 existing tests passed. Browser review covered desktop and 390 px layouts, actual intermediate pill positions during transitions, rapid keyboard tab changes, drawer opening/closing with focus restoration and inert closed content, AI mode changes on fictional local data, and the knowledge dialog. Production login/register switching was verified without submitting a form; no browser errors were reported. Signed-in screens used the local fixture rather than a real user's credentials.
