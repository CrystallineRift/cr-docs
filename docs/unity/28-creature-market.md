# Creature Market Window

Player-facing marketplace opened by interacting (E) with a market broker NPC. Three tabs —
Browse, Sell, My Listings — over the same [Creature Market](../backend/17-creature-market.md)
backend: browsing/buying is server-wide, listing escrows a storage creature, and cancelling
returns it with no fee refund.

## Flow

```
NpcInteractionBehaviour (proximity + E)
  └─ market branch (_marketBehaviour.IsReady, BEFORE the merchant branch)
       ├─ MarketManager.IsAvailable == false → WorldToast "The market is closed while offline." (no open)
       └─ MarketScreenHandler.Open(npcId, accountId, trainerId)
            ├─ ITrainerRepository.GetTrainerById        → wallet
            ├─ MarketManager.GetRulesAsync → MarketRules (listing cap, fee formula; once per Open, falls back to defaults on failure)
            ├─ Browse tab  → MarketManager.BrowseAsync → MarketListingView[] (species/level/seller joined in)
            ├─ Sell tab    → ICreatureInventoryService.GetTeamAsync (team creatures first, "Team" badge)
            │                + ICreatureInventoryService.GetStorageAsync (storage, appended after team)
            │                + ICreatureDomainService.GetCreatureAsync per base creature (species/element)
            │                + MarketManager.GetMyListingsAsync (reused from My Listings, to count Active listings for the cap)
            ├─ My Listings → MarketManager.GetMyListingsAsync → MarketListingView[] (any state)
            ├─ Buy    → MarketManager.BuyAsync    (confirm modal first)
            ├─ List   → MarketManager.ListCreatureAsync
            └─ Cancel → MarketManager.CancelAsync  (confirm modal, "no refund" stated up front)
```

There is no offline counterpart anywhere in this stack — see
[Offline behaviour](#offline-behaviour) below.

## Key files

| File | Role |
|------|------|
| `Assets/CR/UI/Market/MarketScreenHandler.cs` | UI Toolkit screen: three tabs, wallet, filters, confirm modals. `IContextAwareScreen` — force-closes when leaving the Overworld context. |
| `Assets/CR/UI/Market/MarketSellCandidate.cs` | A team or storage `GeneratedCreature` plus the species name/element the Sell picker needs (those live on the base creature, not the generated one) and `IsOnTeam` for the badge and eligibility check. |
| `Assets/CR/UI/Resources/MarketScreen.uxml` / `.uss` | Screen layout and styling — matches `MerchantShopScreen`'s design language (deep navy, blue borders, dimmed overlay), zero inline styles. |
| `Assets/CR/UI/Resources/MarketListingRow.uxml` | One listing row — reused for both Browse (Buy action) and My Listings (Cancel action on Active rows); the handler only binds data/callbacks by element name. |
| `Assets/CR/UI/Market/Logic/*.cs` | Engine-free rules — see [Pure logic](#pure-logic-cruimarketlogic). |
| `Assets/CR/Game/World/Behaviours/NpcMarketBehaviour.cs` | Marks an NPC as a market broker. Nothing to stock (the market has no local inventory) — `IsReady` is set on the same tick `InitializeAsync` runs. |
| `Assets/CR/Game/World/Behaviours/NpcInteractionBehaviour.cs` | Market interact branch, checked **before** the merchant branch; locates the screen lazily (`FindFirstObjectByType`) so market-less scenes still resolve DI. |
| `Assets/CR/Market/Manager/MarketManager.cs` | Online-only entry point: `IsAvailable` gate, HTTP-status → player-text mapping (see below). `BrowseAsync` has a `MarketBrowseQuery` overload — preferred, since a filter field added but not threaded through the positional overload is a filter the player set and the server never saw. |
| `Assets/CR/Market/Http/MarketClientUnityHttp.cs` | REST client; appends the browse query parameters (including the growth bounds via `MarketGrowthQueryParams`) and unwraps the server's `MarketOperationResult` envelope on List/Buy (see [Why an envelope DTO](#why-an-envelope-dto)). |

## Pure logic (`CR.UI.Market.Logic`)

Engine-free asmdef (`noEngineReferences: true`), mirrors `CR.UI.Storage.Logic`'s split between
rules and layout:

| Type | Responsibility |
|------|-----------------|
| `MarketListingRow` | A `MarketListingView` flattened to exactly what a row draws — including the creature's growth-profile values (`GrowthProfileName`, `ExperienceGrowth`, and the six `*Growth` percentages), which arrive on the same view and need no extra round trip. The eight growth constructor arguments are optional and default to "no data". |
| `MarketBrowseFilter` | Server-filterable fields (element/level/price, plus `Growth`) via `ToQuery()`; `HasAdvanced` says whether any growth bound is in play; `Validate()` is the client-side `min > max` pre-check. Species text is a client-side `Matches()` "contains" check — see below. |
| `MarketBrowseQuery` | The `ToQuery()` result: element/minLevel/maxLevel/maxPrice plus a **snapshot** of `Growth` (null when no bound is set), ready for `MarketManager.BrowseAsync`. |
| `MarketGrowthRanges` | The fourteen optional growth bounds (`Min/MaxExperienceGrowth` as `float?`, the six stat pairs as `int?`), declared once and shared by the filter and the query. `HasAny`, `Validate()`, `CopyTo()`. |
| `MarketGrowthQueryParams` | `Append(parameters, growth)` — turns set bounds into the server's query-parameter names, invariant-culture formatted. |
| `MarketGrowthSummary` | `Format(row)` — the per-row growth line; empty string when the listing carries no growth data at all. |
| `MarketSort` / `MarketListingSorter` | Client-side sort (Newest/Price/Level) over the already-fetched page. |
| `MarketFee` | `MarketFee.Compute(askingPrice, feeBase, feePercent)` — `feeBase + round(price * feePercent, AwayFromZero)`, clamped at 0 — mirrors `MarketService.ComputeListingFee` **exactly**, including the rounding mode. `feeBase`/`feePercent` are no longer hard-coded constants: the caller passes the values from `MarketManager.GetRulesAsync()` (`MarketFee.DefaultFeeBase` = 10 / `MarketFee.DefaultFeePercent` = 0.05 remain as the client-side fallback for when that fetch fails), so the fee shown while typing a price matches what the server actually debits even if an environment overrides the config. |
| `MarketOperationKind` | Which call (Browse/List/Buy/Cancel) an HTTP refusal came from — the same status code means a different thing per call. |
| `MarketErrorText` | `(operation, httpStatusCode) → player text`. The client never sees the server's `MarketOperationReason` enum (not shipped to Unity); status code plus which call produced it is the whole signal available. List's 409 copy now also covers the listing cap: "That creature can't be listed right now — it may be untradable, already listed, your last team creature, or you've hit your listing limit." |
| `SellEligibility` | `Evaluate(isTradable, isOnTeam, teamCount, activeListings, maxListings, askingPrice, listingFee, currentGold)`: tradable → last-team-member → listing cap (`activeListings >= maxListings`) → price>0 → fee affordable. This is **not** the same order `MarketService.ListCreatureAsync` checks server-side — the server checks the listing cap (`ListingLimitReached`) before the last-team-member rule (`LastTeamMember`); the client checks last-team-member first. For a trainer at the listing cap trying to list their last team creature, the client shows the last-team-member message but the server would actually refuse with `ListingLimitReached`. A team creature is refused only when it is the trainer's *only* remaining team member (`isOnTeam && teamCount <= 1`); otherwise it may be listed like any storage creature. The cap is per **account**, not per creature — `activeListings` is the account's current count of Active listings across every creature, and refuses with `"You've reached your listing limit ({maxListings})."` before the price/afford checks run. |

Species text is deliberately **not** part of `ToQuery()`: the server's `species` query
parameter is an exact base-creature-id match, not a name search, so there is no endpoint to push
a partial species name to. `MarketBrowseFilter.Matches()` re-filters the already-fetched page on
every keystroke instead — a client-only, no-round-trip operation — while element/level/price wait
for the Search button, since those genuinely need a re-fetch.

Tests live in `Assets/CR/UI/Market/Logic/Tests/` (71 NUnit cases covering fee rounding at exact
`.5` boundaries and against non-default rules, filter matching, sorting, eligibility ordering —
including the last-team-member rule and the per-account listing cap, and that the cap is checked
before the gold check — the growth-bound mapping, `HasAdvanced`, `Validate()`, the query-parameter
names/invariant float formatting, and the row growth summary — and the error-text matrix) and run
both as a throwaway `dotnet test` project and as Unity EditMode tests.

## Why an envelope DTO

`POST /listings`, `POST /listings/{id}/buy`, and `DELETE /listings/{id}` all answer with
`CR.Market.Domain.Services.Models.MarketOperationResult` — a domain-services-internal type that is
**not** shipped to Unity (only `CR.Market.Model.REST` is, per the compat package). Deserializing
that body straight into `MarketListing` (the pre-view client code did this) silently produced an
empty object, since the real JSON shape is `{ success, reason, listing, transaction }`.

`MarketClientUnityHttp` fixes this with `MarketOperationResponse` (`Assets/CR/Market/Http/`) — an
internal wire DTO that mirrors just enough of that shape to unwrap `Listing`. It is not a
recreation of the domain result type (no business logic, no `Reason` enum consumption); the
refusal reason itself is read from the HTTP status code instead, which the server already encodes
one-to-one via `MarketEndpoints.MapResult` (402/403/409/404).

## HTTP status → player text

`MarketManager` catches `SimpleWebClient`'s typed status exceptions and turns each into
`MarketOutcome.Rejected` with `MarketErrorText.For(kind, statusCode)`; everything else (network
failure, timeout, deserialization) is `MarketOutcome.Error` with the exception message for the log:

| Status | Exception | Buy | List | Cancel |
|---|---|---|---|---|
| 402 | `PaymentRequiredException` (new — see below) | "Not enough gold." | "Not enough gold." | — |
| 403 | `ForbiddenException` | "That's your own listing." | "You don't own that creature." | "That's not your listing." |
| 409 | `ConflictException` | "That listing already sold, or your storage is full." | "...may be untradable, already listed, your last team creature, or you've hit your listing limit." | "That listing is no longer active." |
| 404 | `NotFoundException` | "That listing no longer exists." | "That creature or trainer could not be found." | "That listing no longer exists." |

**`PaymentRequiredException`** (`Assets/CR/Core/Data/Logic/PaymentRequiredException.cs`)
is new: `SimpleWebClient.CheckForResponseForErrors` previously had no `case 402`, so a market
`InsufficientFunds` refusal (the only 402 in the client codebase) fell into `default` and came back
as an indistinguishable `InternalServerErrorException` with no body. It now gets its own case,
alongside 409's `ConflictException`, keeping the response body for parity (unused today since the
status code alone disambiguates, but consistent with how 409 is handled).

## Browse: hiding/marking your own listings

Every row is compared by `SellerAccountId` against the current session account. Your own listings
render with a `market-listing-row--own` accent and a disabled "Yours" button instead of "Buy" —
they are not filtered out of the list, since a seller checking whether their listing shows up is a
real use case the Browse tab already answers for free.

That same property is what makes a **shadow ban** invisible from this window. The backend drops a
shadow-banned seller's listings from every other viewer's browse (and 404s their view/buy) but
still returns them to the seller — so the seller sees "Yours" rows exactly as before and nothing
here needs to know a ban exists. There is no client-side hiding to keep in step; see
[Moderation (backend)](../backend/18-moderation.md).

## Sell: team creatures can be listed too

The picker calls `GetTeamAsync` first, then `GetStorageAsync`, and appends both into one candidate
list — team creatures render with a small "Team" badge (`market-sell-candidate-badge` USS class)
ahead of storage. This mirrors the server: `MarketService.ListCreatureAsync` no longer refuses a
listing just because the creature is on the team.

The one rule that remains is **last-team-member**: a trainer may not list the creature that would
leave their team empty. The client enforces the same rule the server 409s on —
`SellEligibility.Evaluate(isTradable, isOnTeam, teamCount, ...)` refuses with "Your last team
creature can't be sold." when `isOnTeam && teamCount <= 1`, where `teamCount` is the team size
captured by `LoadSellCandidatesAsync` at the moment the Sell tab loads. Buying is also
server-gated now: the server 409s (rather than silently dropping the creature) when the buyer's
storage is full, surfaced via `MarketErrorText`'s Buy/409 text.

Non-tradable creatures (starters — `GeneratedCreature.IsTradable`) are shown, not hidden, with a
`market-sell-candidate-row--untradable` dimmed style: selecting one still lets the eligibility line
explain *why* it can't be listed, which is more useful than a card that silently isn't there.

## Market rules and the per-account listing cap

`GET /api/v1/market/rules` returns `CR.Market.Model.REST.MarketRules` (`MaxActiveListings`,
`ListingFeeBase`, `ListingFeePercent`) — server-configured values the client used to hard-code.
`IMarketClient.GetRulesAsync` / `MarketClientUnityHttp.GetRulesAsync` fetch it; `MarketManager.GetRulesAsync`
wraps that the same way as every other call (`IsAvailable` gate, exceptions → `MarketResult`).

`MarketScreenHandler.Open` fetches rules once per open and holds the result in `_marketRules` for
the rest of the session — it is not re-fetched per tab switch or keystroke. On failure it falls
back to `DefaultMarketRules` (max 5, fee 10 + 5%) and logs a warning; the market still opens.

The cap is **per account**, not per creature: an account with 5 Active listings across any mix of
creatures cannot list a 6th, even a brand-new one. The Sell tab shows this as a
`market-sell-listing-count` label ("Listings N/M") next to "Your Creatures", turning red
(`market-sell-listing-count--capped`) at the limit. `N` comes from the same `/mine` load the My
Listings tab uses — `SwitchTabAsync`'s `Sell` case now also calls `RefreshMyListingsAsync` so the
count is fresh even if the player never visited My Listings first — counting rows whose `State ==
ListingState.Active`. `M` is `_marketRules.MaxActiveListings`. Both values feed
`SellEligibility.Evaluate`, which disables the List button and shows "You've reached your listing
limit ({maxListings})." the same way it already disables the button for an untradable or
last-team-member candidate.

`ListingLimitReached` is a new `POST /listings` 409 reason server-side (`MarketErrorText`'s List/409
copy mentions it as a fallback for when the client-side check is stale and the server refuses
anyway — see [backend docs](../backend/17-creature-market.md)).

## Browse filter labels

Each Browse filter control (`market-filter-species`, `market-filter-element`,
`market-filter-minlevel`, `market-filter-maxlevel`, `market-filter-maxprice`,
`market-sort-dropdown`) is now wrapped in a `market-filter-group` (`MarketScreen.uxml`) with a small
`market-filter-label` above it ("Species" / "Element" / "Min Lv" / "Max Lv" / "Max Price" / "Sort")
— previously the filter bar had no labels at all and a new player had no way to tell what an empty
text field or a `0` int field searched on. Element names and control names are unchanged, so
`MarketScreenHandler`'s `Q<T>("market-filter-*")` lookups still resolve; only the USS layout
(`.market-filters` now `align-items: flex-end` so the unlabeled Search button lines up with the
bottom of the labeled fields) changed.

## Advanced search (growth values)

Under the filter bar sits a `market-advanced-toggle` **Button** (`▸ Advanced` collapsed, `▾ Advanced`
expanded — the arrow and the text are set from `MarketScreenHandler.ApplyAdvancedPanelState`). It is
a Button, not a `Foldout`: a focusable container swallows d-pad navigation, and `Button.clicked` is
the only click path a gamepad submit reaches. It toggles `market-advanced-panel`, whose
`style="display: none;"` in `MarketScreen.uxml` is the one deliberate inline style in the screen
(the initial collapsed state has to survive before any code runs).

The panel holds seven min/max pairs — the values stored on the growth profile the listed creature
was generated with. These filter on **values, not profile identity**: `Growth (Swift)` in a row is
display only.

| Control pair | Filter field | Server query params | Type |
|---|---|---|---|
| `market-adv-exp-min` / `-max` | `MinExperienceGrowth` / `Max…` | `minExpGrowth` / `maxExpGrowth` | `FloatField` (50 fast / 100 normal / 200 slow) |
| `market-adv-hp-min` / `-max` | `MinHitPointsGrowth` / `Max…` | `minHpGrowth` / `maxHpGrowth` | `IntegerField` |
| `market-adv-atk-min` / `-max` | `MinAttackGrowth` / `Max…` | `minAtkGrowth` / `maxAtkGrowth` | `IntegerField` |
| `market-adv-def-min` / `-max` | `MinDefenseGrowth` / `Max…` | `minDefGrowth` / `maxDefGrowth` | `IntegerField` |
| `market-adv-spatk-min` / `-max` | `MinSpecialAttackGrowth` / `Max…` | `minSpAtkGrowth` / `maxSpAtkGrowth` | `IntegerField` |
| `market-adv-spdef-min` / `-max` | `MinSpecialDefenseGrowth` / `Max…` | `minSpDefGrowth` / `maxSpDefGrowth` | `IntegerField` |
| `market-adv-spd-min` / `-max` | `MinSpeedGrowth` / `Max…` | `minSpdGrowth` / `maxSpdGrowth` | `IntegerField` |

100 is the baseline for the six stat percentages. `0` means "no bound" (an empty numeric field reads
back as `0`, and a growth value of 0 is not a search anyone wants), matching how the basic level and
price fields already behave.

Behaviour worth knowing:

- **Server-side, like the rest.** Growth bounds ride along on `GET /api/v1/market/listings`
  (`MarketGrowthQueryParams.Append` → `MarketClientUnityHttp.BrowseListingsAsync`), never as a
  post-filter over the fetched page — filtering after paging would silently hide matches on later
  pages. `offset`/`limit` are always sent; the growth params only when set.
- **Applied by Search, not per keystroke.** Like element/level/price, the panel is read into the
  filter when `market-filter-apply` is clicked (`ReadAdvancedFields`).
- **Client pre-check.** `MarketBrowseFilter.Validate()` mirrors the server's `400` on `min > max`
  (now also for level and price). On failure the status label shows e.g.
  `Sp. Def growth min can't be higher than max.` and **no request is sent**.
- **Panel state persists.** `_advancedOpen` lives on the handler, so the panel stays open across
  Search; `WriteAdvancedFields` re-populates the controls if the panel is rebuilt. A *collapsed*
  panel that is still filtering marks the toggle with `market-advanced-toggle--active`, so nobody
  hunts for listings a bound they cannot see is hiding.
- **Invariant formatting.** The float bound is formatted with `CultureInfo.InvariantCulture` — a
  comma decimal separator from a player's locale would reach the server as an unparseable
  `minExpGrowth`.

### Per-row growth summary

`MarketListingRow.uxml` gained a third info label (`market-listing-growth`, class
`market-row-growth`), filled by `MarketGrowthSummary.Format` on both Browse and My Listings rows:

```
Growth (Swift): HP 120  ·  Atk 150  ·  Def 80  ·  SpA 100  ·  SpD 100  ·  Spd 110  ·  Exp 100
```

The profile name is dropped when the server sends none. When a listing carries no growth data at all
(every value zero — an unjoined profile), the formatter returns an empty string and the handler adds
`market-hidden` to the label, rather than drawing a real-looking all-zero creature.

## List/Cancel confirmation

Buy and Cancel both go through a code-built confirm modal (`ShowConfirmModal`, mirrors
`PlayerStorageView.ShowSwapModal`'s pattern — no separate UXML). List does not: `SellEligibility`
already gates the List button live as the seller types a price, so there is nothing left to
confirm that the button's own disabled state hasn't already said. Cancel's modal states "the
listing fee is not refunded" up front — the same rule
[the backend documents](../backend/17-creature-market.md#cancelling-cancellistingasync) as
deliberate (a refundable fee turns list/cancel into free scanning of the escrow).

## Offline behaviour

The market has no offline counterpart anywhere in the stack — `IMarketClient` has no local SQLite
sibling, unlike every online/offline-routed repository elsewhere in the client, because a cached
listing is one that could be sold (or bought) twice.

Two independent gates enforce this, both checking `MarketManager.IsAvailable`
(`IsPlayingOnline` from game config):

1. `NpcInteractionBehaviour`'s market branch checks first and, when offline, shows
   `CR.Core.Notifications.WorldToast.Show("The market is closed while offline.")` and returns
   without opening the screen at all — mirrors the merchant's "shop is unavailable" toast for a
   failed load, reused here as the *only* offline message (there is no in-screen state for it,
   since the screen never opens).
2. `MarketScreenHandler.Open` re-checks the same flag defensively, in case something ever calls
   `Open` directly without routing through the interaction behaviour.

## Scene wiring (Editor)

1. A GameObject named **Market UI** in `Assets/CR/Scenes/Core.unity` (sibling to **Merchant UI**,
   under the same `Menus` parent) carries a `UIDocument` (Panel Settings = the shared
   `Assets/CR/UI/Panel Settings.asset`) and `MarketScreenHandler`, with `marketStyleSheet` and
   `isMenuOpen` (the shared `Assets/CR/Content/Defs/Variables/IsMenuOpen.asset`, same flag
   `PlayerMenuWindow` and the merchant shop use) assigned.
2. Each area's market broker is its own `CR_NPC_Merchant`-prefab instance (same prefab the
   merchant uses) with `NpcMerchantBehaviour` swapped for `NpcMarketBehaviour` and
   `_npcContentKey` set to `npc_market_broker`. One is placed in `Village.unity` (area 1), 4m from
   the existing merchant, sharing its `NpcInteractionBehaviour` tag/interaction-radius/interact-action
   configuration unchanged (inherited from the prefab).
3. No backend seed migration is required for the new NPC: `NpcWorldBehaviour.InitializeAsync` calls
   `EnsureNpcAsync`, which upserts an `npcs` row by content key (online and offline) the first time
   any content key is seen — the same mechanism every other scene-placed NPC relies on.
4. The other four areas (Cave, Shore, Crags, Dunes) do not yet have a market broker placed —
   follow the same recipe (prefab swap + content key) when the market is rolled out to them.

## Related

- [Creature Market (backend)](../backend/17-creature-market.md) — data model, the escrow trainer,
  the transfer core, `MarketListingView` joins, REST status mapping.
- [Moderation (backend)](../backend/18-moderation.md) — shadow bans and admin listing removal;
  the Crystalline Rift Studio LIVE OPS tabs that operate them are in
  [Content Registry → Live ops tabs](08-content-registry.md).
- [Merchant Shop UI](18-merchant-shop.md) — the sibling item-shop screen this one's layout and
  gamepad-navigation patterns are drawn from.
- [Creature Storage](26-creature-storage.md) — `ICreatureInventoryService`, the storage/team
  inventory split the Sell tab reads from.
- [Trainer Currency](../backend/12-trainer-currency.md) — the wallet the listing fee and sale price
  debit/credit.
