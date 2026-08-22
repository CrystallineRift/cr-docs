# Player Character (BoZo body on the Malbers controller)

The player is a **BoZo modular character driven by the Malbers Animal Controller**. The body and
skeleton come from one pack, the movement, states and animation from another.

## Why the swap exists

The Malbers demo player ships one body texture, named `SteveNaked`, and all five of its material
variants are skin tones in underwear. That is fine for a controller demo and wrong for a player
character. The BoZo pack has clothed modular characters but no controller.

## Why it is possible

The two skeletons are **not** bone-compatible:

| | Malbers rig | BoZo rig |
|---|---|---|
| avatar | `Steve_v2Avatar` | `BodyRigAvatar` |
| bone naming | `R_CG`, `R_Spine2`, `R_Head` | `root`, `spine_04`, `head` (Unreal style) |
| body bones | 54 | 84 |

So the trick used for the area NPCs — rebinding a mesh onto the existing skeleton by bone name —
cannot work here; the two share no names at all.

What makes the swap work is that **both avatars are Humanoid**. Mecanim retargets `AC Human v5`
onto any humanoid skeleton, so the controller, every state and every animation keep working on a
body they were never authored for.

## What the swap actually does

The root GameObject is never replaced. `MAnimal`, `Aim`, `IKManager`, `MWeaponManager`, the
Rigidbody, the movement capsule and the `Tags` component all stay exactly as they are; only the
skeleton and meshes underneath change.

1. **Record what the bones mean.** Three bones carry gameplay components (`R_Spine`, `R_Spine2`,
   `R_Head` — hit capsules, and the `Tags` the NPC interaction reads). Each is resolved to its
   `HumanBodyBones` value, copied onto a carrier object, then re-parented onto the equivalent bone
   of the new rig. Meaning survives where names cannot.
2. **Capture every reference into the skeleton.** Malbers hangs a lot off bones — `MAnimal.RootBone`,
   IK goals, weapon equip points, effect origins. Deleting the skeleton nulls all of them, and a
   null `RootBone` is a character that loads with no errors and then does not move. Each reference
   is recorded as the humanoid bone it *meant* and re-pointed afterwards.
3. **Graft the new rig.** The BoZo children are moved to sit directly under the player root, because
   a Humanoid avatar resolves bones by path **relative to the Animator**. Nesting the rig one level
   deeper under a tidy "Model" holder leaves every path unresolvable and the character does not
   animate.
4. **Dress it**, binding each outfit piece's bone array onto the body's skeleton by name (the pieces
   *do* share the body's naming, unlike the two base rigs).
5. **Resize the movement capsule.** BoZo is ~35% taller than Steve, and Malbers grounds the character
   off that capsule; leaving it alone puts the character shin-deep in the floor.

## Commands

The build is **not** idempotent by nature — a second pass would delete the BoZo skeleton the first
one installed and graft another, silently losing the re-homed capsules and the hand equip points.
`cr_swap_player_in_scene` therefore refuses to run on a player that is already on the BoZo avatar;
restore Core from a pre-swap backup to re-run.

**Restore that backup with Core closed in the Editor.** Copying over a scene file Unity has open
raises a "modified externally" modal, which blocks Unity's main thread and stalls the whole CLI
relay until somebody clicks it.

| Command | What it does |
|---|---|
| `cr_build_player_model` | Builds `Assets/CR/Prefabs/Player/CR_Player.prefab` from the Malbers player + BoZo body. |
| `cr_swap_player_in_scene` | Swaps the body of the player already in `Core.unity`, **in place**. |

Prefer the in-scene command for the live player. The scene instance carries around a dozen CR and
Dialogue System components the Malbers prefab has never seen — `TrainerWorldBehaviour`,
`TrainerMovementController`, `ProximitySelector`, `DialogueSystemEvents` and friends — so "delete it
and drop the new prefab in" silently throws all of that away, along with the Cinemachine camera's
tracking target.

## Things that bite

- **`ProxyMesh` is not the body.** The base rig's single visible mesh is a low-poly *fitting
  proxy*: nine blendshapes, all body-shape morphs (Weight, Belly, Muscle), and no way to hide
  anything. The real body is `Body_BasicBody`, a separate piece split into **fourteen region
  renderers** — `chest`, `back`, `shoulders`, `upperarms`, `lowerarms`, `wrists`, `hands`, `hips`,
  `waist`, `upperlegs`, `lowerlegs`, `ankles`, `feet`, `neck`.
- **Hiding skin is not a blendshape — it is switching a region off.** Each garment declares what it
  covers on an `ApplyTags` component (`CoverChest`, `CoverUpperArms`, `CoverLowerLegs`, …) and those
  tag names *are* the region renderer names. Strip `Cover`, disable the match. Skip this and a whole
  naked body renders inside the clothes, pushing through every seam. Tags that are not coverage
  (the boots' `HighKnee`, a fit hint) are reported rather than silently dropped.
- **The head is a separate piece.** `Body_BasicBody` has no head among its fourteen regions — the
  fitting proxy was the only thing supplying a face. Switch the proxy off without adding
  `Head_BasicHead` (plus `Eyes`/`Iris`/`Pupil`) and you get a headless character wearing hair.
- **Anchor unmatched bones on the HEAD for anything head-worn.** Eyes, iris and pupil carry bones
  the body skeleton lacks. Anchored to the rig root — which sits on the floor — those vertices
  stretch from the face to the character's feet as a thin spike. Head, hair, face and makeup slots
  all anchor to the `head` bone.
- **Strip the pack's runtime components after grafting.** Every BoZo component expects to find an
  `OutfitSystem` above it in the hierarchy — and that object is the BoZo prefab root, which the
  graft leaves behind. `BodyShapeModifier` is the loud one: it calls `system.GetBones()` from
  `LateUpdate`, so a null system throws **every frame, once per modified bone** (eleven of them on
  this rig — roughly 660 exceptions a second). The build removes the whole `Bozo.*` namespace from
  the grafted hierarchy, because we use this pack as static art: meshes are bound to the skeleton
  once, at build time, and nothing needs to re-fit them at play time. Matched by namespace rather
  than a list of class names, which would drift the moment the pack updates. It runs **last**, since
  the coverage tags are read off those very components.
- **Re-homed bone objects must inherit the bone's LAYER.** A new GameObject is born on `Default`,
  and the third-person camera's obstacle avoidance (`CinemachineThirdPersonFollow.AvoidObstacles.
  CollisionFilter`) filters on exactly `Default` while deliberately excluding the character's own
  `Animal` layer. Leave the re-homed chest and head capsules on `Default` and the camera treats the
  player's own body as world geometry: it shoves itself out of the torso and **flies upward the
  moment the game starts**. Nothing errors; it just looks like a broken camera.
- **`MAnimal.RootBone` is `Hips.parent`, not the topmost bone.** That is Malbers' own fallback rule
  (`MAnimalLogic`), and on this rig the two differ — `root` versus its wrapper `armature`. MAnimal
  reparents whatever it is given under its Rotator, so guessing here moves the whole rig.
- **The Malbers prefab is tagged `Animal`.** Only the scene instance was ever retagged `Player`.
  Doors, pickups and NPC triggers all test `CompareTag("Player")`, so a fresh drop-in of the built
  prefab is invisible to every one of them. The build sets the tag explicitly.
- **Restructuring a prefab instance is refused.** Moving a child out of one silently fails, so both
  the rig and each outfit piece are unpacked first.
- **Prefab contents live in their own preview scene.** An unparented `InstantiatePrefab` lands in the
  active scene instead and the children never arrive.
- **Hair and capes carry simulation bones the body does not have.** A null entry in a `bones` array
  collapses those vertices to the origin as a smear across the scene; unmatched bones are anchored
  to the head instead, which is rigid but correct.
- **Capsule orientation is approximate.** The re-homed hit capsules sit on the right bones but the
  two skeletons do not share bone axes, so their rotation is inherited rather than converted.
- Steve's face parts (eyes, ears, eyebrows) have no BoZo equivalent and are dropped. BoZo has its own
  `UpperFace` / `LowerFace` slots that are not used yet.
