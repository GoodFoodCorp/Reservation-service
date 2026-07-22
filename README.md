# Reservation Service

Microservice **NestJS** gérant les **réservations de tables**. Chaque réservation
appartient à un restaurant : un franchisé ne voit que les siennes.

| | |
|---|---|
| **Langage / techno** | TypeScript, NestJS 10, Mongoose, class-validator, nestjs-pino, Swagger |
| **Base de données** | MongoDB (port hôte `27018`) |
| **Port HTTP** | `8088` |
| **Documentation API** | http://localhost:8088/docs |

---

## Architecture — structure modulaire NestJS

```
src/
├── main.ts                  # Bootstrap, ValidationPipe, filtre global, Swagger
├── app.module.ts
├── common/
│   ├── auth.util.ts         # Actor, vérification du JWT (HS256 partagé)
│   ├── errors.ts            # Erreurs métier typées (DomainError)
│   ├── decorators/          # @Roles, @CurrentActor
│   ├── filters/             # GlobalExceptionFilter (erreurs métier → HTTP)
│   ├── guards/              # JwtAuthGuard, RolesGuard
│   └── interceptors/        # RequestIdInterceptor (X-Request-ID)
├── core/
│   ├── config/              # ConfigModule + configuration typée
│   └── db/                  # DbModule (connexion Mongo), DbService (readiness)
└── modules/
    ├── reservations/
    │   ├── reservations.controller.ts   # Routes HTTP — zéro logique métier
    │   ├── reservations.service.ts      # Toutes les règles métier
    │   ├── reservations.repository.ts   # Interface + implémentation Mongoose
    │   ├── reservations.module.ts
    │   ├── entities/                    # Schéma Mongoose Reservation
    │   └── dto/                         # CreateReservationDto, UpdateStatusDto
    └── health/                          # /healthz, /readyz
```

**Règle** : le contrôleur valide le DTO et délègue ; toutes les règles vivent dans
le service. Le repository est injecté **par interface**, ce qui permet de tester
le service avec un faux en mémoire, sans MongoDB.

---

## Fonctionnalités

### Côté client
- **Réserver une table** : restaurant, nom, date/heure, nombre de couverts,
  téléphone et note facultatifs
- **Refus des réservations dans le passé**
- **Contrôle de capacité** : maximum **10 tables par créneau d'une heure** par
  restaurant — au-delà, la réservation est refusée (`409`)
- **Consulter ses réservations**
- **Annuler sa propre réservation** (tant qu'elle n'est ni installée ni annulée)

### Côté restaurant (franchisé)
- **Liste des réservations de son restaurant**, filtrable par statut
- **Confirmer** une réservation en attente
- **Installer** les clients (arrivée effective)
- **Annuler** ou marquer **non honorée**

### Cycle de vie

```
PENDING ──▶ CONFIRMED ──▶ SEATED
   │            │
   └──▶ CANCELLED ◀──┴──▶ NO_SHOW
```

Les transitions sont validées : impossible de passer directement de `PENDING` à
`SEATED`, ou de modifier une réservation dans un état terminal (`409`).

### Cloisonnement
- Un franchisé ne voit ni ne modifie les réservations d'un **autre restaurant** (`403`)
- Un client ne consulte ni n'annule les réservations d'un **autre client** (`403`)
- Le détail est accessible au client propriétaire, au franchisé du restaurant et
  au siège

---

## Endpoints

| Méthode | Route | Accès |
|---|---|---|
| POST | `/api/reservations` | `user` |
| GET | `/api/reservations/mine` | authentifié |
| GET | `/api/reservations/restaurant` | `manager` (le sien) |
| GET | `/api/reservations/{id}` | propriétaire, franchisé du resto, `admin` |
| PATCH | `/api/reservations/{id}/status` | `manager` (le sien) |
| PATCH | `/api/reservations/{id}/cancel` | `user` (la sienne) |
| GET | `/healthz`, `/readyz` | public (sondes) |

---

## Lancement

```bash
docker network create microservices-net   # une seule fois, partagé
cp .env.example .env                      # renseigner MONGO_PASSWORD et JWT_SECRET
docker compose up -d --build
```

⚠️ `JWT_SECRET` doit être **identique** à celui de `auth-service`.

### Variables d'environnement

| Variable | Requis | Description |
|---|---|---|
| `PORT` | non (8088) | Port HTTP |
| `MONGO_USER` / `MONGO_PASSWORD` | oui | Credentials du MongoDB dédié |
| `MONGODB_URI` | oui | Le compose la construit pour le conteneur |
| `JWT_SECRET` | oui | Secret HS256 partagé avec `auth-service` |
| `LOG_LEVEL` | non (info) | Niveau de journalisation |

---

## Tests

```bash
npm test              # 11 tests Jest sur le service
npm run test:cov      # avec couverture (seuil 75 %)
npx tsc --noEmit      # vérification des types
```

Les tests couvrent la capacité, les dates passées, l'isolation multi-tenant et le
cycle de vie complet — sans MongoDB (faux repository en mémoire).

> ⚠️ **Aucune CI n'est configurée sur ce projet** — les tests doivent être lancés
> manuellement.
