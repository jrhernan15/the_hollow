/* =========================================================================
   THE HOLLOW — 6 ALCOHOL-FREE THC MOCKTAILS  (ready to paste)
   -------------------------------------------------------------------------
   These are formatted exactly like the entries in cocktails.js. To add them
   to the menu, copy each { ... } block below into the COCKTAILS list in
   cocktails.js (keep the trailing comma after each }).

   - spirit: "Zero-Proof"  -> groups them into their own section + filter chip.
       (The menu auto-creates the section. To control where it appears, add
        "Zero-Proof" to the `spirit` group's `order` array in index.html.)
   - base:   shows "Zero-Proof · 2.5 mg THC" on the card face (the dose).
   - note:   the full safety line shows in the expanded recipe (under
       "Source note —"; you may want to relabel that to "THC note —" in
        index.html for these).

   THC RULE (all six): use a WATER-SOLUBLE / nano-emulsified dispensary product
   (oil tinctures separate in watery drinks); stir the 2.5 mg dose in at the end.

   Sourced by two independent research passes that converged on these builds;
   see the chat for source URLs.
   Fraction glyphs: ½ ⅓ ⅔ ¼ ¾
   ========================================================================= */

const THC_MOCKTAILS = [

  {name:"The Hollow Spritz", spirit:"Zero-Proof", base:"Zero-Proof · 2.5 mg THC", tags:["Bitter","Refreshing/Long","Citrus"], build:"Built", glass:"Wine glass", occasion:"Aperitif",
   summary:`A bittersweet non-alcoholic spritz with a measured dose — the aperitivo hour, zero proof.`,
   spec:[["2 oz","non-alc aperitivo (Ghia/Lyre's)"],["¼ oz","lemon juice"],["2 dashes","non-alc orange bitters"],["3 oz","club soda"],["2.5 mg","water-soluble THC (stir in last)"]],
   steps:[`Build aperitivo, lemon, bitters, and the THC over ice; stir to disperse.`,`Top with club soda and stir once.`],
   garnish:`Orange half-wheel`,
   history:`A zero-proof riff on the Italian spritz; the bitter backbone holds up to cannabis's earthy note.`,
   note:`Contains 2.5 mg THC. Use a water-soluble/nano dispensary product (oil tinctures separate). Start with one, eat first, wait 90+ minutes before another, don't combine with alcohol or drive.`},

  {name:"Phantom Paloma", spirit:"Zero-Proof", base:"Zero-Proof · 2.5 mg THC", tags:["Citrus","Sour/Tart","Refreshing/Long"], build:"Shaken", glass:"Highball", occasion:"Anytime",
   summary:`Grapefruit, lime, and agave over soda — a crisp, tart cooler, dosed.`,
   spec:[["3 oz","grapefruit juice"],["¾ oz","lime juice"],["½ oz","blue agave nectar"],["1 pinch","salt"],["2 oz","club soda"],["2.5 mg","water-soluble THC (stir in last)"]],
   steps:[`Shake grapefruit, lime, agave, and salt with ice.`,`Strain over fresh ice, stir in the THC, then top with club soda.`],
   garnish:`Grapefruit wedge; optional salt rim`,
   history:`The tequila Paloma reimagined alcohol-free; corroborated by both research passes and a cannabis-drink source.`,
   note:`Contains 2.5 mg THC. Use a water-soluble/nano dispensary product (oil tinctures separate). Start with one, eat first, wait 90+ minutes before another, don't combine with alcohol or drive.`},

  {name:"Garden Cooler", spirit:"Zero-Proof", base:"Zero-Proof · 2.5 mg THC", tags:["Herbal","Refreshing/Long","Citrus"], build:"Muddled", glass:"Highball", occasion:"Anytime",
   summary:`Cucumber, mint, and lime over soda — spa-fresh, and built entirely from the bar.`,
   spec:[["5","cucumber slices"],["8–10","mint leaves"],["¾ oz","lime juice"],["½ oz","simple syrup"],["4 oz","club soda"],["2.5 mg","water-soluble THC (stir in last)"]],
   steps:[`Gently muddle cucumber and mint with lime and syrup — press, don't shred the mint.`,`Stir in the THC, add ice, and top with club soda.`],
   garnish:`Cucumber ribbon and a mint sprig`,
   history:`A cucumber-mint cooler; a cannabis dispensary recipe spec'd this build almost exactly.`,
   note:`Contains 2.5 mg THC. Use a water-soluble/nano dispensary product (oil tinctures separate). Start with one, eat first, wait 90+ minutes before another, don't combine with alcohol or drive.`},

  {name:"Copper Hollow Mule", spirit:"Zero-Proof", base:"Zero-Proof · 2.5 mg THC", tags:["Refreshing/Long","Citrus"], build:"Built", glass:"Copper mug", occasion:"Anytime",
   summary:`Lime and spicy ginger beer in a frosty copper mug — the Mule, minus the vodka.`,
   spec:[["¾ oz","lime juice"],["¼ oz","ginger syrup (optional)"],["4 oz","ginger beer"],["2.5 mg","water-soluble THC (stir in last)"]],
   steps:[`Build lime, ginger syrup, and the THC over ice in a copper mug.`,`Top with ginger beer and stir gently.`],
   garnish:`Lime wedge and a mint sprig`,
   history:`The Moscow Mule's alcohol-free cousin; ginger's bite masks any earthy cannabis note.`,
   note:`Contains 2.5 mg THC. Use a water-soluble/nano dispensary product (oil tinctures separate). Start with one, eat first, wait 90+ minutes before another, don't combine with alcohol or drive.`},

  {name:"The Hollow Sour", spirit:"Zero-Proof", base:"Zero-Proof · 2.5 mg THC", tags:["Sour/Tart","Citrus","Creamy/Rich"], build:"Shaken", glass:"Coupe", occasion:"Anytime",
   summary:`A foamed tea sour — tannic backbone, bright lemon, a silky cap.`,
   spec:[["2 oz","cold brewed black tea"],["¾ oz","lemon juice"],["½ oz","demerara (rich) syrup"],["½ oz","egg white (or aquafaba)"],["2.5 mg","water-soluble THC"]],
   steps:[`Stir the THC into the tea, lemon, and syrup; add the egg white.`,`Dry-shake to build foam, then shake again with ice; double-strain into a coupe.`],
   garnish:`Three drops of non-alc aromatic bitters on the foam`,
   history:`A zero-proof whiskey sour; strong black tea stands in for the spirit's tannin and body.`,
   note:`Contains 2.5 mg THC. The dose goes in before the foam so it disperses without disturbing the cap. Use a water-soluble/nano dispensary product. Start with one, eat first, wait 90+ minutes before another, don't combine with alcohol or drive.`},

  {name:"Hollow Colada", spirit:"Zero-Proof", base:"Zero-Proof · 2.5 mg THC", tags:["Creamy/Rich","Fruity","Sweet"], build:"Shaken", glass:"Highball", occasion:"Anytime",
   summary:`Pineapple, coconut cream, and lime — a creamy tropical pour, dosed.`,
   spec:[["2 oz","pineapple juice"],["1½ oz","cream of coconut"],["½ oz","lime juice"],["1 oz","club soda (optional)"],["2.5 mg","water-soluble THC (stir in last)"]],
   steps:[`Shake pineapple, cream of coconut, and lime hard with ice.`,`Strain over fresh ice, stir in the THC, then top with soda to lighten.`],
   garnish:`Pineapple wedge and grated cinnamon`,
   history:`A Piña Colada gone alcohol-free; the coconut fat carries cannabinoids smoothly.`,
   note:`Contains 2.5 mg THC. Use a water-soluble/nano dispensary product (oil tinctures separate). Start with one, eat first, wait 90+ minutes before another, don't combine with alcohol or drive.`},

];
