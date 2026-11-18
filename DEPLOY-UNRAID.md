# BoodschappenLijstje op Unraid

Op de Windows-pc draait geen Docker; je hebt daarom twee routes. De standaardconfiguratie gebruikt de persoonlijke GitHub-account `roebenk`.

## Optie A (aanbevolen): automatisch bouwen via GitHub Actions (GHCR)

1. Zet de code in een GitHub-repo (`git push` naar `main`).
2. De workflow `.github/workflows/docker-publish.yml` bouwt automatisch een `linux/amd64` image en publiceert `ghcr.io/roebenk/boodschappenlijstje:latest`.
3. Houd het package privé en log op Unraid in bij ghcr.io met een Personal Access Token (`read:packages`).
4. Kopieer `unraid/boodschappenlijstje-template.xml` naar `/boot/config/plugins/dockerMan/templates-user/` op Unraid (via SMB-share `flash` of SSH).
5. Unraid → Docker → **Add Container** → kies template **BoodschappenLijstje**. Vul eventueel `OPENROUTER_API_KEY` in en klik **Apply**.
6. Open `http://<unraid-ip>:3017/`.

Updaten: push nieuwe code, wacht tot de workflow klaar is, en klik in Unraid op **Check for updates** → **Apply update**.

## Optie B: direct op Unraid bouwen (Compose Manager / SSH)

1. Kopieer de projectmap naar Unraid, bijvoorbeeld `/mnt/user/appdata/boodschappenlijstje-src` (of `git clone`). Kopieer **niet** je lokale `.env` mee; gebruik die niet in de image.
2. Via SSH:
   ```bash
   cd /mnt/user/appdata/boodschappenlijstje-src
   export OPENROUTER_API_KEY=sk-or-...   # optioneel
   docker compose up -d --build
   ```
   Of voeg de map toe in de **Docker Compose Manager** plugin en kies **Compose Up**; zet de variabelen uit `.env.example` in het `.env`-veld van de stack.
3. Open `http://<unraid-ip>:3017/`. Data staat in `/mnt/user/appdata/boodschappenlijstje`.
4. Updaten: `docker compose up -d --build`.

## Bestaande lokale data meenemen (optioneel)

- Stop de container.
- Kopieer `data\boodschappen.db` (en eventueel `.token.key` en `boodschappen.db-wal`/`-shm` als die bestaan) naar `/mnt/user/appdata/boodschappenlijstje/`.
- Start de container. Zonder `.token.key` kunnen opgeslagen AH/Picnic-tokens niet worden ontsleuteld.
- Of begin schoon: open `http://<unraid-ip>:3000/winkels` en koppel Albert Heijn en Picnic opnieuw.

## Op het iPhone-beginscherm

1. Open de app in **Safari** op `http://<unraid-ip>:3017/` (thuis-wifi, of via VPN/reverse proxy met https).
2. Tik op **Deel** → **Zet op beginscherm** → **Voeg toe**.

## Controle

- Health: `http://<unraid-ip>:3017/api/health`
- Logs: `docker logs boodschappenlijstje`
