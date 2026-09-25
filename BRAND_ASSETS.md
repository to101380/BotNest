# Platform icons and AI model label

Icons identify the connected services. They belong to their respective owners and do not imply a partnership or endorsement. Keep their original proportions and artwork; do not recreate them with text or CSS shapes.

| File | Original asset | Official source |
| --- | --- | --- |
| `public/messenger-icon.svg` | Messenger Icon/Primary Icon/Messenger_Icon_Primary_Blue.svg | [Meta Messenger icon pack](https://www.meta.com/brand/resources/facebook/messenger-icon/) |
| `public/instagram-icon.svg` | Instagram app icon: color gradient background and white camera, 180 px WebP embedded unchanged in an SVG wrapper | [Official Instagram apple-touch-icon](https://static.cdninstagram.com/rsrc.php/yw/r/icwX0xAk0pz.webp), linked from [Instagram](https://www.instagram.com/) |
| `public/line-brand.png` | LINE_Brand_icon.png | [LINE brand icon pack](https://www.line.me/static/logo/top/LINE_Brand_icon.zip), [guidelines](https://www.line.me/en/logo) |
| `public/openai-icon.png` | Official developer documentation favicon | [OpenAI asset](https://developers.openai.com/favicon.png), [guidelines](https://openai.com/brand/) |

The artwork above is copied unchanged from these sources. Instagram must use the full-color app icon requested by the user, not a monochrome or standalone gradient camera glyph. Its SVG wrapper retains the existing shared path used by the Connections card, conversation badges, and customer badges. All assets are served locally, without third-party image requests.

The Connections card and AI settings header display `settings.model` returned by `/api/ai/settings`. The current backend default is `gpt-5.4-mini`. The frontend does not hard-code this default: it formats recognized GPT identifiers, retains unknown identifiers, and clears the label when the session changes or settings cannot be read. Model names are informational, not an editable setting.
