# Storage nodes & RAID pools

Grow the CDN's storage by adding more servers ("nodes") to the one CDN server, then combine them into
**RAID pools** for capacity, speed or redundancy. A pool is an ordinary storage provider: make it the
default for uploads, or select it on a zone, and everything else (delivery, image transforms, media,
replication, lifecycle, revisions) works unchanged.

```
                 ┌──────────────── CDN server (panel, API, worker) ────────────────┐
 uploads ───────▶│  RAID pool "main"  (RAID 5, 3 nodes, 1 MiB chunks)               │
 downloads ◀─────│     stripe 0:  D0 → node A   D1 → node B   P → node C            │
                 │     stripe 1:  D0 → node B   P  → node A   D1 → node C   (parity │
                 │     …                                              rotates)       │
                 └───────┬───────────────────────┬────────────────────────┬────────┘
                         │ HTTPS / Tailscale      │                        │
                   node agent A              node agent B             node agent C
                   (disk 2 TB)               (disk 2 TB)              (disk 2 TB)      → 4 TB usable
```

## RAID levels

| Level | Minimum nodes | Usable space | Survives | Use it for |
|---|---|---|---|---|
| **RAID 0** — stripe | 1 | all nodes | nothing | Scratch / re-creatable data; maximum space and throughput |
| **RAID 1** — mirror | 2 | one node | all but one node | Small, critical data; simplest redundancy |
| **RAID 5** — single parity | 3 | all but one node | 1 node | The usual choice: good space efficiency with redundancy |
| **RAID 6** — double parity | 4 | all but two nodes | 2 nodes | Many or large nodes, where a second failure during a rebuild is a real risk |
| **RAID 10** — striped mirrors | 4 (even) | half the nodes | 1 per mirrored pair | Read-heavy workloads; fastest rebuilds |

Like hardware RAID, every node contributes as much space as the **smallest** node in the pool.

How it works: every file is cut into stripes of `data` chunks plus parity chunks (XOR parity for RAID 5,
XOR + Reed–Solomon for RAID 6). Each node stores one chunk per stripe, and a small manifest
(`<key>.raidmeta`) on every node records the layout. Byte-range requests read only the stripes they
need, so video seeking stays cheap.

## 1. Run the node agent on each extra server

The agent ships in the normal API image. On the new server:

```bash
mkdir cdn-node && cd cdn-node
curl -fsSLO https://raw.githubusercontent.com/cachenetworks/CDNPanel/main/deploy/node/compose.yaml
curl -fsSL  https://raw.githubusercontent.com/cachenetworks/CDNPanel/main/deploy/node/.env.example -o .env
echo "NODE_TOKEN=$(openssl rand -base64 48)" >> .env      # keep this; you paste it into the panel
mkdir -p data && sudo chown 1000:1000 data                 # or point NODE_DATA_DIR at the disk to use
docker compose up -d
```

* **Network**: the agent listens on port `8874`. Shards travel between the CDN server and the node, so
  put the agent on a private network (Tailscale, WireGuard, LAN) by setting `NODE_BIND` to that address,
  or put it behind HTTPS. Every request is authenticated with the token; the agent never talks to the
  database.
* **Disk**: point `NODE_DATA_DIR` at the disk you want to add. The panel shows its size and free space.

## 2. Add the node in the panel

**Administration → Nodes & RAID → Add node**: give it a name, the agent URL (e.g.
`http://100.71.249.127:8874`) and the token. The panel connects, runs a write test and reads the disk
size before saving. The token is stored encrypted and never shown again.

You can also add a **directory on the CDN server itself** as a node (type "Directory on this server"),
so the main server's own disk can be part of a pool.

## 3. Create a pool

**Create pool** → pick the RAID level and the nodes. The dialog shows usable space and how many node
failures the pool survives before you create it. For RAID 10, the node order forms the mirrored pairs
(1+2, 3+4, …): put the halves of a pair on different physical servers.

Then use it:

* **Make default for uploads** (pool menu) — new uploads go to the pool, existing files stay put, or
* select the pool as a zone's storage provider to use it for just that zone.

## Failures, maintenance and rebuilds

* Every node is checked **every minute**. If a node stops answering, its pool turns **degraded** and keeps
  serving every file by reconstructing the missing chunks from parity or mirrors. Uploads keep working
  as long as no more nodes are down than the level tolerates; the skipped chunks are recorded.
* When the node **comes back**, a repair runs automatically and writes the chunks it missed.
* **Replacing a dead server**: add the new server as a node, then in the pool use **Replace** on the dead
  node's slot. The new node is rebuilt from the others in the background (progress shows on the pool).
  The pool keeps serving files while it rebuilds.
* **Planned maintenance**: *Disable* a node first. It is treated as offline (no timeouts for users), and
  re-enabling it triggers the catch-up repair.
* A light **scrub** runs daily to catch anything left degraded. **Full scrub** (pool menu) also checks that
  every chunk on every node exists and has the right size.
* If more nodes fail than the level tolerates, the pool becomes **failed**: reads of affected files fail
  until enough nodes return. RAID 0 has no redundancy at all.

## Growing a pool

**Add nodes…** (pool menu) adds online, unassigned nodes to an existing pool. You can keep the RAID level
or switch to another one that fits the new node count. Examples:

* a one-node pool + a second node → **RAID 1** (every file on both) or **RAID 0** (twice the space)
* RAID 1 with 2 nodes + a third → **RAID 5**
* RAID 5 with 3 nodes + a fourth → RAID 5 with more space, or **RAID 6** with 5+
* RAID 10 grows by whole pairs

New uploads use the new layout immediately. Existing files stay readable on their old layout and are
moved onto the new one in the background (the pool shows "moved to new layout" progress). Each file is
written to its new location first and the old copy is deleted only afterwards, so an interrupted move
never loses data — the next repair simply picks it up again. Every node must be online while the pool
grows, and the new layout must be able to hold what the pool already stores.

## Limits

* Pools grow but never shrink: nodes can be replaced, not removed.
* A node belongs to one pool at a time.
* Up to 32 nodes per pool. Chunk size 256 KiB – 4 MiB (small files automatically use smaller chunks).

## API

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/storage/nodes` | nodes with status and disk space |
| `POST` | `/api/v1/storage/nodes` | add a node (`kind`: `REMOTE` + `url` + `token`, or `LOCAL` + `path`) |
| `PATCH` | `/api/v1/storage/nodes/:id` | rename, move, rotate token, enable / disable |
| `POST` | `/api/v1/storage/nodes/:id/test` | probe now |
| `DELETE` | `/api/v1/storage/nodes/:id` | forget a node that is not in a pool |
| `GET` | `/api/v1/storage/pools` | pools with health, capacity, members and rebuild progress |
| `POST` | `/api/v1/storage/pools` | create (`level`, ordered `node_ids`, `chunk_size_kb`) |
| `POST` | `/api/v1/storage/pools/:id/members` | add nodes (`node_ids`, optional new `level`) and reshape |
| `POST` | `/api/v1/storage/pools/:id/members/:position/replace` | swap a node and rebuild its slot |
| `POST` | `/api/v1/storage/pools/:id/repair` | queue a repair (`verify: true` for a full scrub) |
| `DELETE` | `/api/v1/storage/pools/:id` | delete an empty pool |

All of these require a staff session with the *Manage storage providers* permission; changes require
re-authentication.
