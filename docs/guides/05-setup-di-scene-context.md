# Configuring Scene DI (Zenject SceneContext)

## Goal

By the end of this guide you will have a correctly configured `Scene Context` GameObject in your scene that builds the Zenject DI container with `LocalDevGameInstaller`, making all repositories, domain services, and world bootstrap objects available for injection.

## Prerequisites

- Zenject is installed (`Assets/Plugins/Zenject/` exists in the project).
- You are working in the `My project` Unity project under `cr-data/`.

---

## What SceneContext Does

Zenject's `SceneContext` is a MonoBehaviour that acts as the DI root for a scene. When the scene loads, Zenject finds the `SceneContext` in the Hierarchy, runs all attached installers, and builds the DiContainer. Every MonoBehaviour in the scene that has `[Inject]`-marked methods will then have its dependencies injected before `Start()` runs.

There must be exactly one `SceneContext` per scene.

---

## Step 1 — Create the Scene Context GameObject

1. In the Hierarchy, right-click the scene root and choose **Create Empty**.
2. Rename it `Scene Context` (this is the convention used in `SampleScene`).
3. In the Inspector, set the Transform position to `(0, 0, 0)`.

---

## Step 2 — Add the SceneContext Component

1. With `Scene Context` selected, click **Add Component**.
2. Search for `SceneContext` (it is in the `Zenject` namespace).
3. Add it.

In the Inspector the `SceneContext` component shows several lists:
- **Scriptable Object Installers** — leave empty
- **Mono Installers** — this is where you add `LocalDevGameInstaller`
- **Installer Prefabs** — leave empty

Leave **Auto Run** checked (it defaults to checked). This tells Zenject to build the container automatically when the scene loads.

---

## Step 3 — Add LocalDevGameInstaller

`LocalDevGameInstaller` is a `MonoInstaller` — a MonoBehaviour that contains `InstallBindings()`. It must live on the same GameObject as `SceneContext` so Zenject can reference it.

1. With `Scene Context` still selected, click **Add Component**.
2. Search for `LocalDevGameInstaller` and add it.
3. In the `SceneContext` component's **Mono Installers** list, click **+** and drag the `LocalDevGameInstaller` component from the same GameObject into the new slot.

The component list on `Scene Context` should now be:

```
Scene Context (GameObject)
├── Transform
├── SceneContext
│     Auto Run: ✓
│     Mono Installers:
│       [0] LocalDevGameInstaller (Scene Context)
└── LocalDevGameInstaller
```

This matches what is serialized in `SampleScene.unity`.

---

## Step 4 — Verify the Container Builds

Enter Play mode. The Console should not show any Zenject binding errors. The first sign the container built successfully is the `GameInitializer` log line:

```
[GameInitializer] Injected and subscribed to OnTrainerChanged.
```

If you see a `ZenjectException` or `BindingException` instead, see the Common Mistakes section below.

---

## ProjectContext vs SceneContext

| Aspect | ProjectContext | SceneContext |
|---|---|---|
| Lifetime | Application lifetime (survives scene loads) | Scene lifetime (destroyed on scene unload) |
| Location | `Resources/ProjectContext.prefab` | A GameObject in the scene Hierarchy |
| Use case | Truly global singletons (analytics, global config) | Everything in CR — all repositories and services |

The CR project does not currently use a `ProjectContext`. All bindings are in `LocalDevGameInstaller` on the scene's `SceneContext`. This means every scene load rebuilds the container and re-runs migrations. This is intentional for the current development phase.

---

## How LocalDevGameInstaller Works

`LocalDevGameInstaller.InstallBindings()` does the following in order:

1. Initializes SQLite (`SQLiteInitializer.Initialize()`).
2. Resolves `IDatabaseConnectionStringFactory` to get database paths.
3. Registers all repository implementations (online, offline, and online/offline routers) for every domain.
4. Runs all FluentMigrator migrations synchronously for every database (trainer, auth, creature, spawner — both offline and online-cache variants).
5. Binds all domain services.
6. Binds three runtime GameObjects using `FromNewComponentOnNewGameObject()`:
   - `DatabaseMigrations` (migration component)
   - `GameSessionManager`
   - `GameInitializer` (`.NonLazy()`)
   - `BattleCoordinator`

The migration step (step 4) runs synchronously during `InstallBindings()` and can take a few seconds on first run. This is expected.

---

## Adding a New Installer

If you want to split out a group of bindings into a separate installer (e.g. for a new feature):

1. Create a new class inheriting from `MonoInstaller`:
   ```csharp
   public class MyFeatureInstaller : MonoInstaller
   {
       public override void InstallBindings()
       {
           Container.Bind<IMyFeatureService>().To<MyFeatureService>().AsSingle();
       }
   }
   ```
2. Add `MyFeatureInstaller` as a component on the `Scene Context` GameObject.
3. In the `SceneContext` component's **Mono Installers** list, click **+** and drag the new component into the slot.

Installers run in the order they appear in the **Mono Installers** list. If your new installer depends on bindings from `LocalDevGameInstaller`, ensure `LocalDevGameInstaller` appears first in the list.

---

## Validating the Container Without Play Mode

Zenject supports container validation without entering Play mode:

1. Select the `Scene Context` GameObject.
2. In the Inspector, click the three-dot menu on the `SceneContext` component.
3. Choose **Validate Scene**.

Zenject will attempt to resolve all bindings and report any missing dependencies in the Console. This is faster than entering Play mode for catching DI configuration errors.

---

## Common Mistakes

**"ZenjectException: Unable to resolve type 'IMyService'."**
A binding for `IMyService` is missing in `LocalDevGameInstaller.InstallBindings()`. Add it before any other binding that depends on it.

**"BindingException: Bind(IMyRepo) has already been bound."**
You added a duplicate `Bind<IMyRepo>()` without a `WithId()` qualifier. The online/offline repo pattern uses multiple keyed bindings for the same interface — use `WithId("online")`, `WithId("offline")`, etc., for the keyed ones and a plain non-keyed binding for the router. See [Dependency Injection](?page=unity/02-dependency-injection).

**GameInitializer never appears in the Hierarchy at runtime.**
The `NonLazy()` call is missing from its binding. Locate this line in `LocalDevGameInstaller` and confirm it has `.NonLazy()`:
```csharp
Container.Bind<CR.Game.World.GameInitializer>().FromNewComponentOnNewGameObject().AsSingle().NonLazy();
```
Without `NonLazy()`, the object is not created unless something else resolves `GameInitializer` — and nothing does.

**"Warning: Zenject is resolving during install which is not recommended."**
`LocalDevGameInstaller` calls `Container.Resolve<IDatabaseConnectionStringFactory>()` inside `InstallBindings()` to get connection strings before repository bindings run. This is a known pattern in this codebase and the warning is safe to ignore.

**Migrations fail with "table already exists" or similar.**
FluentMigrator tracks applied migrations in a `VersionInfo` table. If a database file is corrupted or was created by an older migration run, you may need to delete the `.bytes` database files from `Application.persistentDataPath/databases/` and let them be recreated. On macOS, persistent data is under `~/Library/Application Support/<CompanyName>/<ProductName>/`.

**SceneContext inspector shows no Mono Installers slot.**
You forgot to drag the `LocalDevGameInstaller` component into the **Mono Installers** list on `SceneContext`. The component being on the same GameObject is not enough — it must be explicitly referenced in the list.
