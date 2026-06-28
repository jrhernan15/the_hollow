# The Hollow — Cocktail Menu

A self-contained cocktail menu and recipe book for the Hernandez House Bar.
Open `index.html` in any browser to view it. No internet, server, or
build step required — just double-click the file.

## Files

| File | What it is | Do you edit it? |
| --- | --- | --- |
| `index.html` | The website (layout, styling, search, filters, print) | Rarely |
| `recipes.js` | **The menu data — all the drinks** | **Yes, this is the one** |
| `README.md` | This guide | — |

The website reads its drinks from `recipes.js`. To change the menu you only
ever touch `recipes.js`, save it, and refresh the page in your browser.

## Add a drink

1. Open `recipes.js` in any text editor.
2. Copy the template block from the comment at the top of the file.
3. Paste it inside the `[ ... ]` list — put it after another drink's `},`.
4. Fill in the fields, **keep the trailing comma** after the closing `}`.
5. Save, then refresh the page.

A drink looks like this:

```js
{
  name:     "Gimlet",
  spirit:   "Gin",                 // section + Spirit filter
  base:     "Gin",                 // little label above the title
  tags:     ["Sour/Tart","Citrus"],// Flavor chips (must match ALL selected)
  build:    "Shaken",              // Stirred | Shaken | Built | Muddled
  glass:    "Coupe",
  occasion: "Anytime",             // Aperitif | Anytime | Brunch | Nightcap | Digestif
  summary:  "Gin and lime, sharp and spare.",
  spec:[                           // each line is [amount, ingredient]
    ["2 oz","Hendrick's gin"],
    ["¾ oz","lime juice"],
    ["¾ oz","simple syrup"]
  ],
  steps:[ "Shake with ice.", "Strain into a chilled coupe." ],
  garnish: "Lime wheel",
  history: "Royal Navy origin — gin cut with lime against scurvy.",
  note:    "Any spec caveat goes here (shown as 'Source note —')."
},
```

## Remove a drink

Delete its entire `{ ... },` block (including the trailing comma) and save.

## Recommended field values

Using a brand-new value is fine — it still appears and gets its own filter chip.
These are just the ones already in use, in display order:

- **spirit:** Gin, Bourbon, Rye, Tequila, Rum, Vodka, Cognac, Aperitivo
- **tags (flavor):** Spirit-forward, Bitter, Sour/Tart, Sweet, Herbal, Floral, Citrus, Fruity, Refreshing/Long, Creamy/Rich
- **build:** Stirred, Shaken, Built, Muddled
- **glass:** Rocks, Coupe, Highball, Collins, Copper mug, Mug, Julep cup, Wine glass
- **occasion:** Aperitif, Anytime, Brunch, Nightcap, Digestif

To change the **order** sections and filters appear in, edit the `GROUPS` list
inside `index.html`.

## Handy fraction glyphs

Copy/paste as needed: `½  ⅓  ⅔  ¼  ¾  ⅛  ⅙`

## Common mistakes

- **Card didn't show up?** You probably missed a comma, or a quote isn't closed.
  The page shows a "Couldn't load recipes.js" message if a typo breaks the file —
  fix the punctuation and refresh.
- Keep quotes straight (`"`), and don't delete the `[` at the top or `];` at the
  bottom of the list.

## Printing

Use the **Print menu** button (or your browser's print). The print layout
automatically expands every recipe and drops the search/filter controls.
