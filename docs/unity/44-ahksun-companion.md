# Ahksun Companion Shard (Unity)

After the arrival beat "Ahksun rises" (`arrival-ahksun-rises`) has played for the current trainer, Ahksun's shard floats behind-left of the Seeker as they move about the world, and her barks appear over the shard instead of over the Seeker. It is **presentation only**: the shard reads the player's transform and writes only its own, and nothing is granted, recorded or reported. Code lives in `Assets/CR/Game/Story/` (`CompanionShardBehaviour`, `ICompanionAnchor`, `BarkAnchorOffset`); the pure follow math is in `Assets/CR/Game/World/Logic/` (`CompanionFollowExtensions`, `CompanionFollowSettings`, `CompanionFollowState`, `CompanionPoint`), tested in `CompanionFollowTests`. The prefab is `Story/AhksunShard` (a Resources prefab built by `AhksunShardPrefabBuilder`).

## Shard behaviour

| Aspect | Rule |
|---|---|
| Appears | Once the story flag `event.arrival-ahksun-rises` is set for the trainer; polled every 0.5 s |
| Follow | SmoothDamp lag behind-left of the player; bobs; orbits slowly while the player stands still; snaps if farther than 25 m |
| Collision | Pushed off walls and terrain it would otherwise sit inside |
| Hidden | The visual hides during a battle or cutscene, while a story shot owns the camera, and while the world places the player. The anchor itself stays, so a bark keeps its place |
| Wiring | Zenject NonLazy binding in `LocalDevGameInstaller`; tuning values are in `CompanionFollowSettings` |

## Barks anchor on the shard

`ICompanionAnchor` exposes the shard's transform (null before she joins). `ProximityBark` and the `BarnSleepInteraction` morning bark use it as their anchor when present and fall back to the player when it is not. `WorldBarkView` pins the bubble 2.4 m above an anchor's pivot by default (NPC and player roots pivot at the feet); `BarkAnchorOffset` on the shard sets a smaller height (0.45 m default). Barks route by **anchor**, through the existing StoryText barks, not by dialogue speaker. No new bark text was added.

## Dialogue choice sizing

Dialogue option buttons now grow with wrapped text: height `auto`, no shrink, and an `ApplyLayout` min-height floor, so a two- or three-line choice fits with its badge and arrow centred and the gamepad focus ring intact. A very tall option stacks against the panel's max height of 42%. Tested in `DialogueOptionButtonSizingTests`. See [Dialogue System](?page=unity/31-dialogue-system).

## Not yet checked in play

Shard appears after the rise beat, lags and orbits without wall clipping, hides in battle and story shots; descent barks bubble at the shard; a 2 to 3 line choice fits and a very tall one stacks (Edit mode cannot lay out UI Toolkit, so the height growth is unverified).
