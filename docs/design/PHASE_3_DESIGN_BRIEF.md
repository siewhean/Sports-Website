# Phase 3 design brief

## Visual thesis

Sports rulebook meets event control room: warm paper work surfaces, graphite type and rails, one chartreuse signal accent, asymmetric utility layouts, and dense information separated by rhythm rather than dashboard-card mosaics.

## Content plan

1. Settings context: sport, pack version, inheritance level, and saved state.
2. Working surface: schema-driven fields with recommended values, customised markers, validation, and reset.
3. Decision support: capacity status, concise format recommendations, deterministic match and guaranteed-match counts.
4. Administration: versioned default packs, validation state, activation history, and safe publish controls.

## Interaction thesis

- Frequent field, tab, and keyboard actions respond immediately without entrance animation.
- Pressable controls use 120–160 ms transform feedback; occasional drawers and validation disclosures use 160–220 ms opacity/transform transitions with the accepted custom easing curves.
- Inheritance, reset, validation, and save changes preserve spatial context and announce state accessibly; reduced motion removes positional movement.

## Product constraints

- Server Components own reads; isolated client leaves own editing state.
- Geist Sans and Geist Mono, Phosphor icons, no emoji, no decorative gradients, no invented federation authority, and no unsupported claims.
- Labels sit above controls with helper and inline error text. Loading skeletons, empty, invalid, unavailable, permission, and offline/read-only states are explicit.
- Desktop may use an asymmetric context rail and work surface; below 768 px it collapses to one column with 44 px minimum controls and no horizontal overflow.
- Cards are reserved for actual selectable recommendations or elevated validation conflicts. Ordinary settings use open rows, dividers, and whitespace.
