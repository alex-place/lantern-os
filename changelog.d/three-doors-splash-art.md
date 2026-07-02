feat(three-doors): official splash title art + share thumbnail

The Three Doors landing hero now leads with the "THREE DOORS — UNISONA"
key art (Doorwalker and dancer over the Kingdome of Hearts), replacing
the placeholder 🏯 emoji, and both `/three-doors.html` and
`/three-doors-game.html` carry `og:image` / `twitter:image` meta so
shared links get the artwork as their thumbnail. Asset ships as webp
(`public/assets/three-doors-splash.webp`) to stay off the LFS-tracked
extensions. Improves the Act stage (game surface presentation).
Verified live on the lantern-verify preview: asset serves 200
image/webp, hero image decodes at 1672×941, no console errors.
