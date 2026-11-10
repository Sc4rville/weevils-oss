#!/usr/bin/env bash
# weevils installer — one command on a fresh Linux machine or VPS. Idempotent: run it again to update.
#
#   git clone https://github.com/Sc4rville/weevils-oss weevils && cd weevils && ./install.sh
#   curl -fsSL https://raw.githubusercontent.com/Sc4rville/weevils-oss/main/install.sh | bash
#   … | bash -s -- --secondary <ssh host of the main machine>      (a second machine, federated by the main one)
#   ./install.sh --agent      run by an AI agent (see AGENTS.md): no questions, ends with a machine-readable summary
#
# Options: --yes  --agent  --name <first name>  --lang en|fr  --domain <host> | --url <https://…> | --lan  --port <n>
#          --dir <path>  --secondary <ssh-host>  --machine <id>  --no-update  --uninstall [--purge]  --help
set -euo pipefail

# Where this script lives when it runs from a clone (empty when piped from curl). Read here: inside a function,
# bash reports "bash" for a script that comes from stdin.
WEEVILS_SELF=${BASH_SOURCE[0]:-}
WEEVILS_ARGS=("$@")

# The whole installer is one function, called on the last line: a download cut short runs nothing at all.
# The call takes no arguments (they are in WEEVILS_ARGS) and no prefix of its name is a command, so even the last
# line cut in the middle either runs everything with your options or nothing.
_weevils_install() {
# Linux only, checked before anything else: macOS ships bash 3.2, which would die on 'declare -A' below with an
# obscure error instead of this message.
if [ "$(uname -s)" != Linux ] || [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  case "${LC_ALL:-${LANG:-}}" in
    fr*) echo "weevils s'installe sur Linux uniquement (un VPS, une VM Linux, ou WSL2 sous Windows). macOS n'est pas encore pris en charge." >&2 ;;
    *) echo "weevils installs on Linux only (a VPS, a Linux VM, or WSL2 on Windows). macOS is not supported yet." >&2 ;;
  esac
  exit 1
fi
set -- ${WEEVILS_ARGS[@]+"${WEEVILS_ARGS[@]}"}
REPO_URL=${WEEVILS_REPO:-https://github.com/Sc4rville/weevils-oss.git}
SELF=$WEEVILS_SELF
ARGS=("$@")
# PATH as the user has it (the install may prepend ~/.local/bin for itself): the end screen checks wv is reachable.
ORIG_PATH=$PATH

# ---------------------------------------------------------------- messages (English, French)

declare -A EN FR
EN[title]="weevils installer"
FR[title]="installation de weevils"
EN[usage]="usage: install.sh [--yes | --agent] [--name <first name>] [--lang en|fr] [--domain <host> | --url <https://…> | --lan] [--port <n>] [--dir <path>] [--secondary <ssh-host>] [--machine <id>] [--no-update] | --uninstall [--purge]"
FR[usage]="usage : install.sh [--yes | --agent] [--name <prénom>] [--lang en|fr] [--domain <hôte> | --url <https://…> | --lan] [--port <n>] [--dir <dossier>] [--secondary <hôte-ssh>] [--machine <id>] [--no-update] | --uninstall [--purge]"
EN[s_system]="checking the system"
FR[s_system]="vérification du système"
EN[no_tty]="no terminal to ask questions: default answers, and no to anything that installs (run with --yes or from a terminal)"
FR[no_tty]="pas de terminal pour poser des questions : réponses par défaut, et non à tout ce qui installe (lance avec --yes ou depuis un terminal)"
EN[no_tty_no]="no terminal to answer: taken as no. Run with --yes or from a terminal."
FR[no_tty_no]="pas de terminal pour répondre : je prends ça pour un non. Lance avec --yes ou depuis un terminal."
EN[root_warn]="running as root: Claude Code refuses to skip permission prompts as root, so agents here will ask before acting (WEEVILS_SAFE=1). A regular user with sudo is better (adduser me && usermod -aG sudo me)."
FR[root_warn]="lancé en root : Claude Code refuse de sauter les demandes de permission en root, donc les agents demanderont avant d'agir (WEEVILS_SAFE=1). Mieux vaut un utilisateur normal avec sudo (adduser moi && usermod -aG sudo moi)."
EN[wsl]="WSL detected: your phone can't reach WSL as is. Use Tailscale (on Windows or in WSL), or networkingMode=mirrored in %UserProfile%\\.wslconfig; add vmIdleTimeout=-1 there too, or WSL stops (and weevilsd with it) when no terminal is open."
FR[wsl]="WSL détecté : ton téléphone ne peut pas joindre WSL tel quel. Passe par Tailscale (sous Windows ou dans WSL), ou networkingMode=mirrored dans %UserProfile%\\.wslconfig ; ajoute aussi vmIdleTimeout=-1, sinon WSL s'arrête (et weevilsd avec) quand aucun terminal n'est ouvert."
EN[no_sudo]="installing packages needs root: run as root, or install sudo."
FR[no_sudo]="installer des paquets demande root : lance en root, ou installe sudo."
EN[sudo_pw]="this step needs root and sudo asks for a password, which can't be typed here. Run the same command once in a terminal (it asks for the password), or install these first:"
FR[sudo_pw]="cette étape demande root et sudo veut un mot de passe, impossible à taper ici. Lance la même commande une fois dans un terminal (elle demandera le mot de passe), ou installe d'abord :"
EN[agent_next]="for the agent: now read AGENTS.md in this folder, steps 6 and 7, and end with the short message it describes, in the user's language (no commands, no technical notes):"
FR[agent_next]="pour l'agent : lis maintenant AGENTS.md dans ce dossier, étapes 6 et 7, et termine par le court message qu'il décrit, dans la langue de l'utilisateur (pas de commandes, pas de notes techniques) :"
EN[agent_mode]="run by an agent: no questions, no colours, a summary at the end"
FR[agent_mode]="lancé par un agent : pas de questions, pas de couleurs, un résumé à la fin"
EN[no_pm]="no supported package manager (apt, dnf, pacman). Install these by hand, then run me again:"
FR[no_pm]="pas de gestionnaire de paquets connu (apt, dnf, pacman). Installe-les à la main, puis relance-moi :"
EN[missing]="missing:"
FR[missing]="manquant :"
EN[ask_pkgs]="install them now?"
FR[ask_pkgs]="je les installe ?"
EN[installing]="installing"
FR[installing]="installation de"
EN[refused]="can't go on without them. Install them, then run me again."
FR[refused]="impossible de continuer sans eux. Installe-les, puis relance-moi."
EN[node_old]="needs Node.js >= 22.18 (found:"
FR[node_old]="il faut Node.js >= 22.18 (trouvé :"
EN[ask_node]="install Node.js 22 (NodeSource)?"
FR[ask_node]="j'installe Node.js 22 (NodeSource) ?"
EN[node_hint]="install Node.js 22 or newer (https://nodejs.org), then run me again."
FR[node_hint]="installe Node.js 22 ou plus récent (https://nodejs.org), puis relance-moi."
EN[npm_nosudo]="npm is missing and installing it needs root: install npm (or Node.js from https://nodejs.org), then run me again."
FR[npm_nosudo]="npm manque et l'installer demande root : installe npm (ou Node.js depuis https://nodejs.org), puis relance-moi."
EN[tmux_old]="tmux >= 3.2 is needed (found"
FR[tmux_old]="il faut tmux >= 3.2 (trouvé :"
EN[tmux_hint]="install a newer tmux (your distribution's backports, or build it), then run me again."
FR[tmux_hint]="installe un tmux plus récent (backports de ta distribution, ou compilé), puis relance-moi."
EN[no_claude]="Claude Code is not installed. weevils needs it: weevboss runs on it (Codex is optional)."
FR[no_claude]="Claude Code n'est pas installé. weevils en a besoin : weevboss tourne dessus (Codex est optionnel)."
EN[ask_claude]="install Claude Code now (official installer, into ~/.local/bin)?"
FR[ask_claude]="j'installe Claude Code maintenant (installateur officiel, dans ~/.local/bin) ?"
EN[claude_failed]="Claude Code could not be installed. Install it by hand, then log in once:"
FR[claude_failed]="Claude Code n'a pas pu être installé. Installe-le à la main, puis connecte-toi une fois :"
EN[claude_later]="later, to install Claude Code:"
FR[claude_later]="plus tard, pour installer Claude Code :"
EN[codex_opt]="Codex (optional), to install it:"
FR[codex_opt]="Codex (optionnel), pour l'installer :"
EN[s_source]="getting weevils"
FR[s_source]="récupération de weevils"
EN[cloning]="cloning into"
FR[cloning]="clonage dans"
EN[updating]="updating"
FR[updating]="mise à jour de"
EN[no_pull]="local changes or no upstream: keeping this version (no git pull)"
FR[no_pull]="modifs locales ou pas de branche suivie : je garde cette version (pas de git pull)"
EN[pull_failed]="git pull failed: keeping this version"
FR[pull_failed]="git pull a échoué : je garde cette version"
EN[not_repo]="exists but is not a weevils clone: pick another --dir"
FR[not_repo]="existe mais n'est pas un clone de weevils : choisis un autre --dir"
EN[s_config]="your settings"
FR[s_config]="tes réglages"
EN[ask_name]="your first name (the agents call you by it)"
FR[ask_name]="ton prénom (les agents t'appellent comme ça)"
EN[ask_domain]="domain for HTTPS, pointing to this machine (empty: none, I'll show the other ways in)"
FR[ask_domain]="domaine pour le HTTPS, qui pointe vers cette machine (vide : aucun, je te montrerai les autres accès)"
EN[port_busy]="port taken, weevils uses the next free pair:"
FR[port_busy]="port déjà pris, weevils prend la paire libre suivante :"
EN[cfg_new]="created"
FR[cfg_new]="créé"
EN[cfg_kept]="kept your values in"
FR[cfg_kept]="tes valeurs gardées dans"
EN[s_build]="dependencies and app build"
FR[s_build]="dépendances et construction de l'app"
EN[deps_ok]="dependencies up to date"
FR[deps_ok]="dépendances à jour"
EN[build_ok]="app already built for this version"
FR[build_ok]="app déjà construite pour cette version"
EN[s_service]="weevilsd service"
FR[s_service]="service weevilsd"
EN[bg_mode]="no systemd here (container, WSL…): weevilsd runs in the background, without auto-start at boot. Control it with: weevils-service start|stop|status|logs"
FR[bg_mode]="pas de systemd ici (conteneur, WSL…) : weevilsd tourne en arrière-plan, sans démarrage auto au boot. Pour le piloter : weevils-service start|stop|status|logs"
EN[cron_added]="auto-start at boot added to your crontab (@reboot)"
FR[cron_added]="démarrage au boot ajouté à ta crontab (@reboot)"
EN[s_https]="HTTPS with Caddy"
FR[s_https]="HTTPS avec Caddy"
EN[caddy_nopm]="Caddy could not be installed here: install it by hand (https://caddyserver.com/docs/install), then run me again."
FR[caddy_nopm]="Caddy n'a pas pu être installé ici : installe-le à la main (https://caddyserver.com/docs/install), puis relance-moi."
EN[caddy_nosudo]="the HTTPS site in /etc/caddy needs sudo: kept as it is."
FR[caddy_nosudo]="le site HTTPS dans /etc/caddy demande sudo : laissé tel quel."
EN[ask_ufw]="ufw is active: open ports 80 and 443 for HTTPS?"
FR[ask_ufw]="ufw est actif : j'ouvre les ports 80 et 443 pour le HTTPS ?"
EN[https_nodns]="does not resolve yet: point a DNS A/AAAA record to this machine, then run me again. Check with: getent ahosts"
FR[https_nodns]="ne se résout pas encore : fais pointer un enregistrement DNS A/AAAA vers cette machine, puis relance-moi. Vérifie avec : getent ahosts"
EN[https_down]="does not answer yet: check the DNS record, ports 80 and 443 (ufw, your provider's firewall), and: sudo journalctl -u caddy -n 30"
FR[https_down]="ne répond pas encore : vérifie l'enregistrement DNS, les ports 80 et 443 (ufw, pare-feu de l'hébergeur), et : sudo journalctl -u caddy -n 30"
EN[caddy_bad]="Caddy refuses the new config: previous Caddyfile restored, HTTPS skipped."
FR[caddy_bad]="Caddy refuse la nouvelle config : ancien Caddyfile remis, HTTPS laissé de côté."
EN[waiting]="waiting for weevilsd"
FR[waiting]="j'attends weevilsd"
EN[down]="weevilsd does not answer. Look at: weevils-service status, weevils-service logs"
FR[down]="weevilsd ne répond pas. Regarde : weevils-service status, weevils-service logs"
EN[ready]="weevils is ready"
FR[ready]="weevils est prêt"
EN[almost_login]="almost ready: run claude once in a terminal to log in, then open the link"
FR[almost_login]="presque prêt : lance claude une fois dans un terminal pour te connecter, puis ouvre le lien"
EN[almost_install]="almost ready: install Claude Code and log in once, then open the link"
FR[almost_install]="presque prêt : installe Claude Code et connecte-toi une fois, puis ouvre le lien"
EN[codex_login]="Codex is not logged in: run codex once in a terminal (optional)"
FR[codex_login]="Codex n'est pas connecté : lance codex une fois dans un terminal (optionnel)"
EN[safe_off]="agents run without permission prompts (WEEVILS_SAFE=1 in ~/.config/weevils/env to keep them)"
FR[safe_off]="les agents tournent sans demande de permission (WEEVILS_SAFE=1 dans ~/.config/weevils/env pour les garder)"
EN[safe_on]="agents ask before acting (WEEVILS_SAFE=1): answer them from the app"
FR[safe_on]="les agents demandent avant d'agir (WEEVILS_SAFE=1) : réponds-leur depuis l'app"
EN[no_qr]="(no QR code: install qrencode to get one)"
FR[no_qr]="(pas de QR code : installe qrencode pour en avoir un)"
EN[no_path]="~/.local/bin is not in your PATH: wv won't be found. Fix:"
FR[no_path]="~/.local/bin n'est pas dans ton PATH : wv sera introuvable. Pour corriger :"
EN[address]="address"
FR[address]="adresse"
EN[code]="access code"
FR[code]="code d'accès"
EN[link]="login link"
FR[link]="lien de connexion"
EN[unreachable]="your phone can't reach this yet: weevilsd listens on 127.0.0.1 only. Pick a way in:"
FR[unreachable]="ton téléphone ne peut pas encore y accéder : weevilsd n'écoute que sur 127.0.0.1. Choisis un accès :"
EN[via_domain]="a domain pointing to this machine (HTTPS, recommended): run me again with"
FR[via_domain]="un domaine qui pointe vers cette machine (HTTPS, recommandé) : relance-moi avec"
EN[via_tailscale]="Tailscale (phone and machine on the same tailnet, HTTPS):"
FR[via_tailscale]="Tailscale (téléphone et machine sur le même tailnet, HTTPS) :"
EN[via_lan]="same Wi-Fi at home, plain http (never on a VPS): run me again with"
FR[via_lan]="même Wi-Fi à la maison, en http simple (jamais sur un VPS) : relance-moi avec"
EN[via_tunnel]="from a computer, an SSH tunnel, then the link above:"
FR[via_tunnel]="depuis un ordi, un tunnel SSH, puis le lien ci-dessus :"
EN[lan_public]="WARNING: this address is not a private network address. Over plain http the access code and everything you do travel in clear on the internet. Use --domain instead."
FR[lan_public]="ATTENTION : cette adresse n'est pas une adresse de réseau privé. En http simple, le code d'accès et tout ce que tu fais passent en clair sur internet. Prends plutôt --domain."
EN[lan_https]="over plain http, the phone allows neither the microphone nor notifications: HTTPS (--domain or Tailscale) brings them."
FR[lan_https]="en http simple, le téléphone n'autorise ni le micro ni les notifications : le HTTPS (--domain ou Tailscale) les apporte."
EN[next]="next, on your phone: scan the QR code (or open the link), then iPhone: Share → Add to Home Screen; Android: ⋮ → Install app. weevboss welcomes you there and walks you through the rest."
EN[next_local]="next, on your phone: give it a way in first (one of the four above), then open the link and add it to the home screen (iPhone: Share → Add to Home Screen; Android: ⋮ → Install app). weevboss walks you through the rest."
EN[laptop]="this is a laptop: your agents stop when it sleeps. weevboss will suggest a small VPS so they work overnight."
FR[next]="ensuite, sur ton téléphone : scanne le QR code (ou ouvre le lien), puis iPhone : Partager → Sur l'écran d'accueil ; Android : ⋮ → Installer l'application. weevboss t'y accueille et te guide pour la suite."
FR[next_local]="ensuite, sur ton téléphone : donne-lui d'abord un chemin (un des quatre ci-dessus), puis ouvre le lien et ajoute-le à l'écran d'accueil (iPhone : Partager → Sur l'écran d'accueil ; Android : ⋮ → Installer l'application). weevboss te guide pour la suite."
FR[laptop]="c'est un portable : tes agents s'arrêtent quand il se met en veille. weevboss te proposera un petit VPS pour qu'ils bossent la nuit."
# The last lines of the end screen: what is already in the app, and the first thing to try ({n}: a number).
EN[have_projects]="already in the app: your {n} Claude Code projects of the last few days, with their sessions"
FR[have_projects]="déjà dans l'app : tes {n} projets Claude Code de ces derniers jours, avec leurs sessions"
EN[have_project1]="already in the app: your Claude Code project of the last few days, with its sessions"
FR[have_project1]="déjà dans l'app : ton projet Claude Code de ces derniers jours, avec ses sessions"
EN[have_repos]="your {n} repos in ~/projects are ready: weevboss can start a session in any of them"
FR[have_repos]="tes {n} repos de ~/projects sont prêts : weevboss peut lancer une session dans n'importe lequel"
EN[try_write]='first thing to try: open the app and write to weevboss, in the field at the top ("tell me what to do"):'
FR[try_write]="à essayer en premier : ouvre l'app et écris à weevboss, dans le champ du haut (« dis-moi quoi faire ») :"
EN[try_voice]="first thing to try: open the app, tap the weevboss logo at the top and say:"
FR[try_voice]="à essayer en premier : ouvre l'app, touche le logo de weevboss en haut et dis :"
EN[try_projects]='"what are my projects up to?"'
FR[try_projects]="« où en sont mes projets ? »"
EN[try_new]='"make me a small notes app"'
FR[try_new]="« fais-moi une petite app de notes »"
EN[secondary_ok]="this machine reports to"
FR[secondary_ok]="cette machine remonte vers"
EN[secondary_next]="its sessions show up in the app of the main machine. Start one here with: wv"
FR[secondary_next]="ses sessions apparaissent dans l'app de la machine principale. Lances-en une ici avec : wv"
EN[ssh_fail]="can't reach the main machine without a password. Set up an SSH key, then run me again:"
FR[ssh_fail]="impossible de joindre la machine principale sans mot de passe. Mets une clé SSH en place, puis relance-moi :"
EN[bad_opt]="invalid value:"
FR[bad_opt]="valeur invalide :"
EN[node_shadow]="an older node comes first in your PATH; weevils uses the new one in /usr/bin. Remove the old one if you can:"
FR[node_shadow]="un node plus ancien passe en premier dans ton PATH ; weevils prend le nouveau dans /usr/bin. Enlève l'ancien si tu peux :"
EN[yes]="Y/n"
FR[yes]="O/n"
EN[s_uninstall]="removing weevils"
FR[s_uninstall]="désinstallation de weevils"
EN[ask_uninstall]="remove weevils from this machine (service, commands, hooks, HTTPS site)?"
FR[ask_uninstall]="je retire weevils de cette machine (service, commandes, hooks, site HTTPS) ?"
EN[un_service]="service stopped and removed"
FR[un_service]="service arrêté et retiré"
EN[un_hooks]="weevils hooks removed from ~/.claude/settings.json"
FR[un_hooks]="hooks weevils retirés de ~/.claude/settings.json"
EN[un_bin]="commands removed from ~/.local/bin"
FR[un_bin]="commandes retirées de ~/.local/bin"
EN[un_cron]="@reboot line removed from your crontab"
FR[un_cron]="ligne @reboot retirée de ta crontab"
EN[un_caddy]="HTTPS site removed from Caddy"
FR[un_caddy]="site HTTPS retiré de Caddy"
EN[un_caddy_sudo]="removing the HTTPS site needs sudo: remove /etc/caddy/weevils.caddy and its import line from /etc/caddy/Caddyfile by hand."
FR[un_caddy_sudo]="retirer le site HTTPS demande sudo : enlève à la main /etc/caddy/weevils.caddy et sa ligne import dans /etc/caddy/Caddyfile."
EN[un_purged]="settings, access code and data deleted"
FR[un_purged]="réglages, code d'accès et données supprimés"
EN[un_kept]="kept (--purge deletes them): your settings and access code in ~/.config/weevils, data in ~/.local/share/weevils"
FR[un_kept]="gardés (--purge les supprime) : tes réglages et ton code d'accès dans ~/.config/weevils, les données dans ~/.local/share/weevils"
EN[un_clone]="the code stays in"
FR[un_clone]="le code reste dans"
EN[un_tmux]="agent sessions still running in tmux are left alone (wv ls)."
FR[un_tmux]="les sessions d'agents encore ouvertes dans tmux ne sont pas touchées (wv ls)."
EN[un_done]="weevils is removed"
FR[un_done]="weevils est désinstallé"
EN[aborted]="nothing changed."
FR[aborted]="rien n'a changé."

# ---------------------------------------------------------------- options

YES=0 NAME='' LANG_OPT='' DOMAIN='' URL_OPT='' PORT='' DIR='' SECONDARY='' MACHINE='' NO_UPDATE=${WEEVILS_NO_UPDATE:-0}
LAN=0 UNINSTALL=0 PURGE=0 AGENT=0
while [ $# -gt 0 ]; do
  case "$1" in
    -y | --yes) YES=1 ;;
    --agent) AGENT=1 YES=1 ;;
    --url) URL_OPT=${2:?--url}; shift ;;
    --name) NAME=${2:?--name}; shift ;;
    --lang) LANG_OPT=${2:?--lang}; shift ;;
    --domain) DOMAIN=${2:?--domain}; shift ;;
    --port) PORT=${2:?--port}; shift ;;
    --dir) DIR=${2:?--dir}; shift ;;
    --secondary) SECONDARY=${2:?--secondary}; shift ;;
    --machine) MACHINE=${2:?--machine}; shift ;;
    --no-update) NO_UPDATE=1 ;;
    --lan) LAN=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --purge) PURGE=1 ;;
    -h | --help) sed -n 2,9p "${SELF:-/dev/null}" 2>/dev/null | sed 's/^# \{0,1\}//'; HELP=1 ;;
    *) echo "unknown option: $1" >&2; BAD=1 ;;
  esac
  shift
done
# Values checked before anything runs. A domain may come as a URL: only the host is kept.
DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
BAD_VAL=''
case "$LANG_OPT" in '' | en | fr) ;; *) BAD_VAL="--lang $LANG_OPT (en, fr)" ;; esac
case "$PORT" in '') ;; *[!0-9]*) BAD_VAL="--port $PORT" ;; *) [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || BAD_VAL="--port $PORT" ;; esac
[ -z "$DOMAIN" ] || [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || BAD_VAL="--domain $DOMAIN"
[[ "$SECONDARY" != -* ]] || BAD_VAL="--secondary $SECONDARY"
[ "$PURGE" = 0 ] || [ "$UNINSTALL" = 1 ] || BAD_VAL="--purge (only with --uninstall)"
[ "$LAN" = 0 ] || [ -z "$DOMAIN" ] || BAD_VAL="--lan with --domain (pick one)"
# --url: the address the phone opens when something else already serves HTTPS in front of this machine (tailscale
# serve, a reverse proxy of your own). weevilsd stays on 127.0.0.1; only WEEVILS_PUBLIC_URL is set.
URL_OPT=${URL_OPT%/}
[ -z "$URL_OPT" ] || [[ "$URL_OPT" =~ ^https?://[A-Za-z0-9.:-]+(/[^[:space:]]*)?$ ]] || BAD_VAL="--url $URL_OPT (http(s)://host)"
[ -z "$URL_OPT" ] || { [ -z "$DOMAIN" ] && [ "$LAN" = 0 ]; } || BAD_VAL="--url with --domain or --lan (pick one)"

# Run by an AI agent (Claude Code sets CLAUDECODE=1, Codex its CODEX_* variables; CODEX_HOME is a user setting, not a
# sign) with no terminal on stdin and stdout: same as --agent. The user asked their agent to install weevils, so that
# request is the consent --yes stands for: without it every "install?" would be a silent no and the install would
# fail. It stays safe: sudo is only used when it needs no password (sudo -n, see check_system), never a prompt that
# would hang; otherwise the script stops and says what needs root. A human in a terminal is never affected (tty).
AGENT_NAME=''
if [ "${CLAUDECODE:-}" = 1 ]; then AGENT_NAME=claude
else for v in $(compgen -e); do case "$v" in CODEX_HOME) ;; CODEX_*) AGENT_NAME=codex ;; esac; done; fi
if [ "$AGENT" = 0 ] && [ -n "$AGENT_NAME" ] && [ ! -t 0 ] && [ ! -t 1 ]; then AGENT=1 YES=1; fi

# Language: --lang, else the one already in your settings (a re-run speaks like the first run), else the locale.
# Always ~/.config/weevils (not XDG_CONFIG_HOME): the server and the systemd unit read it there.
CONF_DIR=$HOME/.config/weevils
CONF_FILE=$CONF_DIR/env
if [ -n "$LANG_OPT" ]; then L=$LANG_OPT
else
  L=$(sed -n "s/^[[:space:]]*WEEVILS_LANG[[:space:]]*=[[:space:]]*[\"']\{0,1\}\([a-z]*\).*/\1/p" "$CONF_FILE" 2>/dev/null | head -1 || true)
  [ -n "$L" ] || case "${LC_ALL:-${LANG:-}}" in fr*) L=fr ;; *) L=en ;; esac
fi
[ "$L" = fr ] || L=en
t() { if [ "$L" = fr ]; then printf '%s' "${FR[$1]}"; else printf '%s' "${EN[$1]}"; fi; }

# ---------------------------------------------------------------- output

if [ -t 1 ] && [ "$AGENT" = 0 ]; then B=$'\e[1m' D=$'\e[2m' R=$'\e[0m' Y=$'\e[30;43m' G=$'\e[32m' O=$'\e[33m' E=$'\e[31m' M=$'\e[35m'
else B='' D='' R='' Y='' G='' O='' E='' M=''; fi
step() { printf '\n%s %s %s\n' "$Y$B" "$1" "$R"; }
ok() { printf '  %s✓%s %s\n' "$G" "$R" "$*"; }
info() { printf '  %s·%s %s\n' "$D" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$O$B" "$R" "$*"; }
die() { printf '  %s✗ %s%s\n' "$E$B" "$*" "$R" >&2; summary failed "$*"; exit 1; }
star() { printf '  %s★ %s%s\n' "$M$B" "$*" "$R"; }
# tn key n — a message with its {n} replaced by a number.
tn() { local m; m=$(t "$1"); printf '%s' "${m//\{n\}/$2}"; }

# The summary an agent parses (--agent only): key=value lines between two fixed markers, printed once, last.
# kv key value adds a line; summary status [error] prints the block (status: ok, failed, needs_sudo).
SUMMARY_BODY=''
SUMMARY_DONE=0
kv() { SUMMARY_BODY+="$1=$(printf '%s' "$2" | tr '\n' ' ')"$'\n'; }
summary() {
  [ "$AGENT" = 1 ] && [ "$SUMMARY_DONE" = 0 ] || return 0
  SUMMARY_DONE=1
  printf '\n--- weevils summary ---\nstatus=%s\n' "$1"
  [ -z "${2:-}" ] || printf 'error=%s\n' "$(printf '%s' "$2" | tr '\n' ' ')"
  printf '%slang=%s\nagent=%s\n--- end ---\n' "$SUMMARY_BODY" "$L" "$AGENT_NAME"
}

# Questions go through the terminal even when the script comes from curl | bash.
TTY=0
if [ "$YES" = 0 ] && { : </dev/tty; } 2>/dev/null; then TTY=1; fi
confirm() { # confirm "question" → 0 = yes. Without a terminal (and without --yes) nobody can say yes: it is a no.
  [ "$YES" = 0 ] || return 0
  [ "$TTY" = 1 ] || { info "$1 — $(t no_tty_no)"; return 1; }
  local a; printf '  %s?%s %s [%s] ' "$M$B" "$R" "$1" "$(t yes)" >/dev/tty; read -r a </dev/tty || a=''
  case "$a" in '' | y* | Y* | o* | O*) return 0 ;; *) return 1 ;; esac
}
ask() { # ask "question" default → answer on stdout
  if [ "$YES" = 1 ] || [ "$TTY" = 0 ]; then printf '%s' "$2"; return; fi
  local a; printf '  %s?%s %s%s: ' "$M$B" "$R" "$1" "${2:+ [$2]}" >/dev/tty; read -r a </dev/tty || a=''
  printf '%s' "${a:-$2}"
}

# ---------------------------------------------------------------- system

SUDO=''
SUDO_PW=0
PM=''
IS_WSL=0
APT_UPDATED=0
# An existing config file (a Caddyfile already there…) is always kept, never asked about.
APT_KEEP='-o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold'
# quiet cmd… — runs a noisy command, shows its output only when it fails.
quiet() {
  local log; log=$(mktemp)
  if "$@" >"$log" 2>&1; then rm -f "$log"; else local rc=$?; tail -n 30 "$log" >&2; rm -f "$log"; return "$rc"; fi
}
pkg_install() { # pkg_install pkg… (names for the detected package manager)
  info "$(t installing) $*"
  case "$PM" in
    apt)
      if [ "$APT_UPDATED" = 0 ]; then quiet $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq; APT_UPDATED=1; fi
      quiet $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $APT_KEEP --no-install-recommends "$@" ;;
    dnf) quiet $SUDO dnf install -y -q "$@" ;;
    # No -y: refreshing the database without upgrading is a partial upgrade, which Arch warns against.
    pacman) quiet $SUDO pacman -Syu --noconfirm --needed "$@" ;;
  esac
}

node_ok() {
  command -v node >/dev/null || return 1
  local v; v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
  local maj=${v%%.*} rest=${v#*.}; local min=${rest%%.*}
  [ "$maj" -gt 22 ] || { [ "$maj" = 22 ] && [ "$min" -ge 18 ]; }
}

# Something needs root and there is no way to get it here. As an agent whose sudo wants a password: say so, and the
# summary gives the same install to run once from a terminal (it asks for the password there). Otherwise: refused.
no_root() { # no_root [what needs it]
  if [ "$SUDO_PW" = 1 ]; then
    printf '  ✗ %s %s\n' "$(t sudo_pw)" "${1:-}" >&2
    kv needs "${1:-}"
    kv retry "$(retry_cmd)"
    summary needs_sudo "$(t sudo_pw) ${1:-}"
    exit 3
  fi
  die "$(t no_sudo)"
}
# The same install for a human in a terminal: this clone's install.sh (or the curl one), same options, no --agent.
retry_cmd() {
  local a out
  if [ -n "$SELF" ] && [ -f "$SELF" ]; then out="cd $(printf '%q' "$(cd "$(dirname "$SELF")" && pwd)") && ./install.sh"
  else out="curl -fsSL https://raw.githubusercontent.com/Sc4rville/weevils-oss/main/install.sh | bash -s --"; fi
  for a in ${ARGS[@]+"${ARGS[@]}"}; do [ "$a" = --agent ] || out+=" $(printf '%q' "$a")"; done
  printf '%s' "$out"
}

check_system() {
  step "$(t s_system)"
  [ "$TTY" = 1 ] || [ "$YES" = 1 ] || info "$(t no_tty)"
  [ "$AGENT" = 0 ] || info "$(t agent_mode)"
  # WSL: its network is not reachable from the phone as is, and the VM stops when idle (said again on the end screen).
  if grep -qi microsoft /proc/version 2>/dev/null; then IS_WSL=1; info "$(t wsl)"; fi
  if [ "$(id -u)" = 0 ]; then warn "$(t root_warn)"
  elif command -v sudo >/dev/null; then
    SUDO=sudo
    # An agent can't type a password, and a prompt would hang: sudo only when it needs none.
    if [ "$AGENT" = 1 ]; then if sudo -n true 2>/dev/null; then SUDO='sudo -n'; else SUDO=none SUDO_PW=1; fi; fi
  else SUDO=none; fi
  # --domain sets up Caddy in /etc: without sudo, stop here, before anything is written.
  [ -z "$DOMAIN" ] || [ -n "$SECONDARY" ] || [ "$SUDO" != none ] || no_root caddy
  if command -v apt-get >/dev/null; then PM=apt
  elif command -v dnf >/dev/null; then PM=dnf
  elif command -v pacman >/dev/null; then PM=pacman; fi

  # Commands weevils needs, then the package that brings each one.
  local need=(git curl tmux jq python3) missing=() pkgs=()
  [ -n "$SECONDARY" ] && need+=(ssh)
  for c in "${need[@]}"; do command -v "$c" >/dev/null || missing+=("$c"); done
  # systemd --user needs the user bus (apt); the QR code on the end screen needs qrencode (optional, same name on
  # apt, dnf and pacman). Without a terminal nor --yes, nothing optional is installed.
  local extra=()
  if [ "$PM" = apt ]; then
    [ -d /run/systemd/system ] && ! dpkg -s dbus-user-session >/dev/null 2>&1 && extra+=(dbus-user-session)
    dpkg -s ca-certificates >/dev/null 2>&1 || extra+=(ca-certificates)
  fi
  [ -z "$PM" ] || command -v qrencode >/dev/null || extra+=(qrencode)
  [ "$TTY" = 1 ] || [ "$YES" = 1 ] || extra=()
  for c in "${missing[@]}"; do
    case "$c:$PM" in
      ssh:pacman | ssh:dnf) pkgs+=(openssh-clients) ;;
      ssh:*) pkgs+=(openssh-client) ;;
      *) pkgs+=("$c") ;;
    esac
  done
  [ "$PM" = pacman ] && pkgs=("${pkgs[@]/openssh-clients/openssh}")
  if [ ${#missing[@]} -gt 0 ]; then
    warn "$(t missing) ${missing[*]}"
    [ -n "$PM" ] || die "$(t no_pm) ${missing[*]}"
    [ "$SUDO" != none ] || no_root "${missing[*]}"
    confirm "$(t ask_pkgs)" || die "$(t refused)"
  fi
  if [ ${#pkgs[@]} -gt 0 ] || [ ${#extra[@]} -gt 0 ]; then
    [ "$SUDO" != none ] || { [ ${#pkgs[@]} -eq 0 ] || no_root "${missing[*]}"; }
    [ "$SUDO" = none ] || pkg_install ${pkgs[@]+"${pkgs[@]}"} ${extra[@]+"${extra[@]}"}
  fi
  for c in "${need[@]}"; do command -v "$c" >/dev/null || die "$(t missing) $c"; done
  # weevilsd and wv start sessions with 'tmux new-session -e', which came with tmux 3.2.
  local tv; tv=$(tmux -V 2>/dev/null | grep -oE '[0-9]+\.[0-9]+' | head -1 || true)
  if [ -n "$tv" ] && { [ "${tv%%.*}" -lt 3 ] || { [ "${tv%%.*}" = 3 ] && [ "${tv#*.}" -lt 2 ]; }; }; then
    die "$(t tmux_old) $tv). $(t tmux_hint)"
  fi
  ok "git, curl, tmux${tv:+ $tv}, jq, python3"

  if ! node_ok; then
    warn "$(t node_old) $(node -v 2>/dev/null || echo —))"
    if [ "$PM" = apt ] || [ "$PM" = dnf ] || [ "$PM" = pacman ]; then
      [ "$SUDO" != none ] || no_root "node 22"
      confirm "$(t ask_node)" || die "$(t node_hint)"
      # The setup script goes through a private temp file (a fixed name in /tmp could be planted by another user).
      local ns; ns=$(mktemp)
      case "$PM" in
        apt) curl -fsSL https://deb.nodesource.com/setup_22.x -o "$ns"
          quiet $SUDO bash "$ns"
          quiet $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $APT_KEEP nodejs ;;
        dnf) curl -fsSL https://rpm.nodesource.com/setup_22.x -o "$ns"
          quiet $SUDO bash "$ns"
          quiet $SUDO dnf install -y -q nodejs ;;
        pacman) pkg_install nodejs npm ;;
      esac
      rm -f "$ns"
      hash -r
      # An older node elsewhere (a tarball in /usr/local/bin…) may still come first: use the new one from /usr/bin.
      if ! node_ok && [ -x /usr/bin/node ] && PATH=/usr/bin:$PATH node_ok; then
        warn "$(t node_shadow) $(command -v node)"
        PATH=/usr/bin:$PATH; export PATH; hash -r
      fi
      node_ok || die "$(t node_hint)"
    else die "$(t node_hint)"; fi
  fi
  # Debian/Ubuntu's own nodejs comes without npm.
  if ! command -v npm >/dev/null; then
    [ "$SUDO_PW" = 0 ] || no_root npm
    [ "$PM" = apt ] && [ "$SUDO" != none ] || die "$(t npm_nosudo)"
    pkg_install npm
    command -v npm >/dev/null || die "npm: $(t node_hint)"
  fi
  ok "node $(node -v), npm $(npm -v)"

  check_agents
}

# Claude Code is required (weevboss runs on it), Codex is optional. The official installer puts claude in
# ~/.local/bin, which the service PATH already has.
CLAUDE_INSTALLER='curl -fsSL https://claude.ai/install.sh | bash'
check_agents() {
  if ! command -v claude >/dev/null && [ -x "$HOME/.local/bin/claude" ]; then PATH=$HOME/.local/bin:$PATH; export PATH; fi
  if ! command -v claude >/dev/null; then
    warn "$(t no_claude)"
    if confirm "$(t ask_claude)"; then
      info "$(t installing) Claude Code"
      if quiet bash -c "set -o pipefail; $CLAUDE_INSTALLER" </dev/null; then PATH=$HOME/.local/bin:$PATH; export PATH; hash -r; fi
      command -v claude >/dev/null || { warn "$(t claude_failed)"; info "$CLAUDE_INSTALLER"; info "claude"; }
    else
      info "$(t claude_later) $CLAUDE_INSTALLER"
    fi
  fi
  if command -v claude >/dev/null; then ok "claude $(claude --version 2>/dev/null | head -1 | awk '{print $1}' || true)"; fi
  if command -v codex >/dev/null; then ok "codex"
  else
    # NodeSource's npm installs globally into /usr: without write access there, it takes sudo.
    local prefix sudo_npm=''
    prefix=$(npm prefix -g 2>/dev/null || true)
    [ -n "$prefix" ] && [ -w "$prefix/lib" ] || [ "$(id -u)" = 0 ] || sudo_npm='sudo '
    info "$(t codex_opt) ${sudo_npm}npm i -g @openai/codex"
  fi
}

# ---------------------------------------------------------------- source

get_source() {
  step "$(t s_source)"
  local here=''
  if [ -n "$SELF" ] && [ -f "$SELF" ]; then
    here=$(cd "$(dirname "$SELF")" && pwd)
    [ -f "$here/server/install.sh" ] && [ -f "$here/package.json" ] || here=''
  fi
  if [ -z "$DIR" ] && [ -n "$here" ]; then DIR=$here; fi
  DIR=${DIR:-$HOME/weevils}
  case "$DIR" in /*) ;; *) DIR=$PWD/$DIR ;; esac

  if [ ! -e "$DIR" ]; then
    info "$(t cloning) $DIR"
    git clone -q "$REPO_URL" "$DIR"
  elif [ -f "$DIR/server/install.sh" ] && [ -d "$DIR/.git" ]; then
    if [ "$NO_UPDATE" = 0 ]; then
      if [ -z "$(git -C "$DIR" status --porcelain --untracked-files=no)" ] && git -C "$DIR" rev-parse -q --verify '@{u}' >/dev/null 2>&1; then
        info "$(t updating) $DIR"
        local before; before=$(git -C "$DIR" rev-parse HEAD)
        if git -C "$DIR" pull -q --ff-only; then
          # A newer installer came with the update: hand over to it.
          if [ "$before" != "$(git -C "$DIR" rev-parse HEAD)" ] && ! git -C "$DIR" diff --quiet "$before" HEAD -- install.sh; then
            WEEVILS_NO_UPDATE=1 exec bash "$DIR/install.sh" ${ARGS[@]+"${ARGS[@]}"} --dir "$DIR"
          fi
        else warn "$(t pull_failed)"; fi
      else info "$(t no_pull)"; fi
    fi
  else die "$DIR $(t not_repo)"; fi
  ok "$DIR ($(git -C "$DIR" log -1 --format='%h %cs' 2>/dev/null || echo '?'))"
}

# ---------------------------------------------------------------- config

slug() { tr 'A-Z' 'a-z' <<<"$1" | tr -c 'a-z0-9-\n' '-' | sed 's/^-*//; s/-*$//' | cut -c1-20; }
# port_taken <port> — something listens on it (bash's /dev/tcp: no ss or netstat needed).
port_taken() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

configure() {
  step "$(t s_config)"
  local svc="$DIR/server/weevils-service" conf=$CONF_FILE fresh=0
  cfg() { "$svc" config "$@"; }
  mkdir -p "$(dirname "$conf")"
  if [ ! -f "$conf" ]; then
    install -m 600 "$DIR/.env.example" "$conf"
    fresh=1
  fi
  # A flag given now updates its key; otherwise a value already there is never overwritten.
  local name=$NAME
  if [ -z "$name" ] && [ -z "$(cfg get WEEVILS_USER_NAME)" ]; then name=$(ask "$(t ask_name)" ""); fi
  [ -z "$name" ] || cfg set WEEVILS_USER_NAME "$name"
  if [ -n "$LANG_OPT" ]; then cfg set WEEVILS_LANG "$L"; else cfg default WEEVILS_LANG "$L"; fi
  if [ -n "$PORT" ]; then cfg set WEEVILS_PORT "$PORT"; else cfg default WEEVILS_PORT 4179; fi
  cfg default WEEVILS_HOOK_PORT 4180
  # A new config takes the first free pair of ports (another app, or another user's weevils, may hold 4179/4180).
  if [ "$fresh" = 1 ] && [ -z "$PORT" ]; then
    local p h n=0
    p=$(cfg get WEEVILS_PORT) h=$(cfg get WEEVILS_HOOK_PORT)
    while { port_taken "$p" || port_taken "$h"; } && [ "$n" -lt 20 ]; do p=$((p + 2)) h=$((h + 2)) n=$((n + 1)); done
    if [ "$n" -gt 0 ]; then cfg set WEEVILS_PORT "$p"; cfg set WEEVILS_HOOK_PORT "$h"; info "$(t port_busy) $p/$h"; fi
  fi
  # --lan: listen on every interface, for a phone on the same home network (plain http).
  [ "$LAN" = 0 ] || cfg set WEEVILS_HOST 0.0.0.0
  # --domain after an earlier --lan: back to 127.0.0.1, Caddy is the only way in (no plain http on every interface).
  [ -z "$DOMAIN" ] || [ "$(cfg get WEEVILS_HOST)" != 0.0.0.0 ] || cfg set WEEVILS_HOST 127.0.0.1
  # Claude Code refuses --dangerously-skip-permissions as root: agents keep their permission prompts there.
  [ "$(id -u)" != 0 ] || cfg default WEEVILS_SAFE 1
  # --url: HTTPS is served by something else in front (tailscale serve…): weevilsd back on 127.0.0.1, behind it.
  if [ -n "$URL_OPT" ]; then
    cfg set WEEVILS_PUBLIC_URL "$URL_OPT"
    [ "$(cfg get WEEVILS_HOST)" != 0.0.0.0 ] || cfg set WEEVILS_HOST 127.0.0.1
  fi
  if [ -z "$SECONDARY" ] && [ -z "$DOMAIN" ] && [ "$LAN" = 0 ] && [ -z "$(cfg get WEEVILS_PUBLIC_URL)" ] && ! site_mine; then
    DOMAIN=$(ask "$(t ask_domain)" ""); DOMAIN=${DOMAIN#http://}; DOMAIN=${DOMAIN#https://}; DOMAIN=${DOMAIN%%/*}
    [ -z "$DOMAIN" ] || [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { warn "$(t bad_opt) $DOMAIN"; DOMAIN=''; }
  fi
  # The HTTPS site needs sudo: refused before the public URL is written.
  [ -z "$DOMAIN" ] || [ -n "$SECONDARY" ] || [ "$SUDO" != none ] || no_root caddy
  PREV_PUBLIC_URL=$(cfg get WEEVILS_PUBLIC_URL)
  [ -z "$DOMAIN" ] || cfg set WEEVILS_PUBLIC_URL "https://$DOMAIN"
  # The machine id: only on a new config (an older one keeps the id it already had), or when --machine is given.
  local host; host=$(slug "$(hostname -s 2>/dev/null || cat /etc/hostname)")
  if [ -n "$MACHINE" ]; then cfg set WEEVILS_MACHINE "$(slug "$MACHINE")"; cfg set WEEVILS_MACHINE_NAME "$MACHINE"
  elif [ "$fresh" = 1 ] || [ -n "$SECONDARY" ]; then cfg default WEEVILS_MACHINE "${host:-main}"; cfg default WEEVILS_MACHINE_NAME "${host:-main}"; fi
  # The access code (weevilsd would create it too): here, so the end screen always has it.
  local secret=$CONF_DIR/secret
  [ -s "$secret" ] || (umask 077 && head -c 9 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' >"$secret")
  if [ "$fresh" = 1 ]; then ok "$(t cfg_new) $conf"; else ok "$(t cfg_kept) $conf"; fi
  info "WEEVILS_USER_NAME=$(cfg get WEEVILS_USER_NAME)  WEEVILS_LANG=$(cfg get WEEVILS_LANG)  WEEVILS_PORT=$(cfg get WEEVILS_PORT)  WEEVILS_MACHINE=$(cfg get WEEVILS_MACHINE)"
}

# ---------------------------------------------------------------- build

build() {
  step "$(t s_build)"
  cd "$DIR"
  # The main machine builds the app with vite (a devDependency): include dev deps even if the shell sets
  # NODE_ENV=production or npm omit=dev. A secondary machine only runs the server: no dev deps.
  local omit=--include=dev stamp
  [ -n "$SECONDARY" ] && omit=--omit=dev
  stamp="$(sha256sum package-lock.json | cut -c1-16) $(node -v) $omit"
  if [ -f node_modules/.weevils-stamp ] && [ "$(cat node_modules/.weevils-stamp)" = "$stamp" ]; then ok "$(t deps_ok)"
  else
    quiet npm ci --no-audit --no-fund --no-update-notifier $omit
    echo "$stamp" >node_modules/.weevils-stamp
    ok "npm ci"
  fi
  # A secondary machine serves no app: only the main one builds it.
  [ -z "$SECONDARY" ] || return 0
  stamp="$(git rev-parse HEAD 2>/dev/null) $(git status --porcelain 2>/dev/null | sha256sum | cut -c1-16)"
  if [ -f dist/index.html ] && [ -f dist/.weevils-stamp ] && [ "$(cat dist/.weevils-stamp)" = "$stamp" ]; then ok "$(t build_ok)"
  else
    quiet npx --no-update-notifier vite build
    echo "$stamp" >dist/.weevils-stamp
    ok "vite build → dist/"
  fi
}

# ---------------------------------------------------------------- service

service() {
  step "$(t s_service)"
  if [ -n "$SECONDARY" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new "$SECONDARY" true 2>/dev/null || {
      warn "$(t ssh_fail)"
      info "ssh-keygen -t ed25519 && ssh-copy-id $SECONDARY"
      exit 1
    }
    WEEVILS_NO_PROMPT=$AGENT bash "$DIR/server/install.sh" secondary "$SECONDARY" | sed 's/^/  · /'
  else
    WEEVILS_NO_PROMPT=$AGENT bash "$DIR/server/install.sh" main | sed 's/^/  · /'
  fi
  if [ "$("$DIR/server/weevils-service" mode)" != systemd ]; then
    warn "$(t bg_mode)"
    if command -v crontab >/dev/null && ! crontab -l 2>/dev/null | grep -q 'weevils-service start'; then
      { crontab -l 2>/dev/null || true; echo "@reboot $HOME/.local/bin/weevils-service start"; } | crontab - && info "$(t cron_added)"
    fi
  fi
}

# ---------------------------------------------------------------- HTTPS

# Caddy from its official apt repo (Debian, Ubuntu).
caddy_apt() {
  pkg_install debian-keyring debian-archive-keyring apt-transport-https gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | $SUDO gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | $SUDO tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  APT_UPDATED=0
  pkg_install caddy
}

# /etc/caddy/weevils.caddy is one file for the whole machine: only the user who wrote it adopts, updates or removes
# it (a site written before the owner line existed counts as ours).
site_mine() {
  local site=/etc/caddy/weevils.caddy
  [ -f "$site" ] || return 1
  ! grep -q '^# weevils — written by install.sh for ' "$site" || grep -qx "# weevils — written by install.sh for $(id -un)" "$site"
}

https() {
  [ -z "$SECONDARY" ] || return 0
  local site=/etc/caddy/weevils.caddy cf=/etc/caddy/Caddyfile tls='' undo port
  port=$("$DIR/server/weevils-service" config get WEEVILS_PORT)
  [ "${WEEVILS_CADDY_TLS:-}" = internal ] && tls=$'\n\ttls internal'
  # A re-run without --domain keeps the site set up before, with the current port (moved by --port or by hand).
  if [ -z "$DOMAIN" ] && site_mine; then
    DOMAIN=$(awk 'index($0, "{") { print $1; exit }' "$site")
    [ -n "$DOMAIN" ] || return 0
    grep -q 'tls internal' "$site" && tls=$'\n\ttls internal'
    grep -qE "reverse_proxy 127\.0\.0\.1:$port\$" "$site" && return 0
    [ "$SUDO" != none ] || { warn "$(t caddy_nosudo)"; return 0; }
  fi
  [ -n "$DOMAIN" ] || return 0
  step "$(t s_https)"
  [ "$SUDO" != none ] || no_root caddy
  if ! command -v caddy >/dev/null; then
    case "$PM" in
      apt) caddy_apt || true ;;
      dnf | pacman) pkg_install caddy || true ;;
    esac
    command -v caddy >/dev/null || {
      "$DIR/server/weevils-service" config set WEEVILS_PUBLIC_URL "$PREV_PUBLIC_URL"
      die "$(t caddy_nopm)"
    }
  fi
  ok "$(caddy version 2>/dev/null | awk '{print "caddy " $1}')"
  # Our site in its own file; the Caddyfile only imports it. An existing Caddyfile keeps all its sites.
  # Both files are saved first and put back together if Caddy rejects the result: a rejected run leaves the
  # config exactly as it was (a half-changed one would break every site at the next Caddy restart).
  $SUDO mkdir -p /etc/caddy
  undo=$($SUDO mktemp -d)
  [ ! -f "$cf" ] || $SUDO cp -p "$cf" "$undo/Caddyfile"
  [ ! -f "$site" ] || $SUDO cp -p "$site" "$undo/weevils.caddy"
  # The Caddyfile as it was before weevils ever touched it, kept once.
  [ ! -f "$cf" ] || [ -f "$cf.bak-weevils" ] || $SUDO cp -p "$cf" "$cf.bak-weevils"
  printf '# weevils — written by install.sh for %s\n%s {%s\n\treverse_proxy 127.0.0.1:%s\n}\n' "$(id -un)" "$DOMAIN" "$tls" "$port" | $SUDO tee "$site" >/dev/null
  if [ ! -f "$cf" ] || grep -q 'The Caddyfile is an easy way to practice' "$cf"; then
    # No Caddyfile, or the untouched placeholder of the package: ours replaces it (backup kept).
    printf 'import %s\n' "$site" | $SUDO tee "$cf" >/dev/null
  elif ! grep -qE "^[[:space:]]*import[[:space:]]+$site" "$cf"; then
    printf '\nimport %s\n' "$site" | $SUDO tee -a "$cf" >/dev/null
  fi
  if ! $SUDO caddy validate --config "$cf" --adapter caddyfile >/dev/null 2>&1; then
    local f
    for f in Caddyfile weevils.caddy; do
      if $SUDO test -f "$undo/$f"; then $SUDO cp -p "$undo/$f" "/etc/caddy/$f"; else $SUDO rm -f "/etc/caddy/$f"; fi
    done
    $SUDO rm -rf "$undo"
    "$DIR/server/weevils-service" config set WEEVILS_PUBLIC_URL "$PREV_PUBLIC_URL"
    warn "$(t caddy_bad)"
    DOMAIN=''
    return 0
  fi
  $SUDO rm -rf "$undo"
  if [ -d /run/systemd/system ]; then
    $SUDO systemctl enable caddy >/dev/null 2>&1 || true
    $SUDO systemctl reload-or-restart caddy
  else
    $SUDO caddy reload --config "$cf" --adapter caddyfile >/dev/null 2>&1 || $SUDO caddy start --config "$cf" --adapter caddyfile >/dev/null 2>&1
  fi
  ok "https://$DOMAIN → 127.0.0.1:$port"
  # A firewall that blocks 80/443 is the usual first-time failure: offer to open them.
  if command -v ufw >/dev/null && $SUDO ufw status 2>/dev/null | grep -q 'Status: active' &&
    ! $SUDO ufw status 2>/dev/null | grep -qE '^(80,443/tcp|443(/tcp)?) .*ALLOW'; then
    if confirm "$(t ask_ufw)"; then quiet $SUDO ufw allow 80,443/tcp && ok "ufw allow 80,443/tcp"; fi
  fi
  https_check "$tls"
}

# https_check [tls] — does https://DOMAIN answer from here (DNS, ports, certificate)? Up to a minute: the first
# certificate takes a few seconds. A name that does not resolve is said at once.
https_check() {
  local k=''
  [ -z "${1:-}" ] || k=-k
  if ! getent ahosts "$DOMAIN" >/dev/null 2>&1; then warn "$DOMAIN $(t https_nodns) $DOMAIN"; return 0; fi
  for _ in $(seq 1 30); do
    curl -sf $k -m 3 -o /dev/null "https://$DOMAIN/api/me" && { ok "https://$DOMAIN/api/me"; return 0; }
    sleep 2
  done
  warn "https://$DOMAIN $(t https_down)"
}

# ---------------------------------------------------------------- end screen

# The address a phone on the same network would use: the source address of the default route (not docker0 or a
# VPN address that hostname -I may list first).
lan_ip() {
  local ip
  ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }' || true)
  [ -n "$ip" ] || ip=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
  printf '%s' "$ip"
}
# private_ip <ipv4> — RFC 1918 or CGNAT (100.64/10, Tailscale's range too).
private_ip() {
  local a b r
  IFS=. read -r a b r <<<"$1"
  case "$a" in
    10) return 0 ;;
    192) [ "$b" = 168 ] ;;
    172) [ "${b:-0}" -ge 16 ] 2>/dev/null && [ "$b" -le 31 ] ;;
    100) [ "${b:-0}" -ge 64 ] 2>/dev/null && [ "$b" -le 127 ] ;;
    *) return 1 ;;
  esac
}

# What is left to do on the end screen: notes on agents, permissions, PATH.
agent_notes() {
  local svc="$DIR/server/weevils-service"
  if ! command -v claude >/dev/null; then info "$(t claude_later) $CLAUDE_INSTALLER"; fi
  if command -v codex >/dev/null && [ ! -s "$HOME/.codex/auth.json" ]; then info "$(t codex_login)"; fi
  if [ "$("$svc" config get WEEVILS_SAFE)" = 1 ]; then info "$(t safe_on)"; else warn "$(t safe_off)"; fi
  case ":$ORIG_PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) warn "$(t no_path)"; info "echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.bashrc && . ~/.bashrc" ;;
  esac
}

# ---------------------------------------------------------------- what is already here

# Claude Code logged in: its credentials, or a key in the environment or in the settings.
claude_logged() {
  local svc="$DIR/server/weevils-service"
  [ -s "$HOME/.claude/.credentials.json" ] || [ -n "${ANTHROPIC_API_KEY:-}${CLAUDE_CODE_OAUTH_TOKEN:-}" ] ||
    [ -n "$("$svc" config get ANTHROPIC_API_KEY)$("$svc" config get CLAUDE_CODE_OAUTH_TOKEN)" ]
}
yn() { if "$@" >/dev/null 2>&1; then echo yes; else echo no; fi; }

# What the app will find at once, so nobody redoes or re-proposes it: agents and their logins, GitHub, projects
# (folders of ~/.claude/projects with a session in the last 3 days, what the app lists; weevboss's own folders and
# the session running this install left out), repos in the project folders, Tailscale, a laptop.
detect() {
  local svc="$DIR/server/weevils-service" d sid=${CLAUDE_CODE_SESSION_ID:-none} roots root r
  HAVE_CLAUDE=$(yn command -v claude) CLAUDE_OK=no
  [ "$HAVE_CLAUDE" = no ] || CLAUDE_OK=$(yn claude_logged)
  HAVE_CODEX=$(yn command -v codex) CODEX_OK=no
  [ "$HAVE_CODEX" = no ] || [ ! -s "${CODEX_HOME:-$HOME/.codex}/auth.json" ] || CODEX_OK=yes
  HAVE_GH=$(yn command -v gh) GH_OK=no GH_LOGIN=''
  [ "$HAVE_GH" = no ] || GH_LOGIN=$(timeout 8 gh api user -q .login 2>/dev/null || true)
  [ -z "$GH_LOGIN" ] || GH_OK=yes
  N_PROJECTS=0 N_PROJECTS_ALL=0
  for d in "$HOME"/.claude/projects/*/; do
    case "$d" in *-local-share-weevils*) continue ;; esac
    [ -n "$(find "$d" -maxdepth 1 -name '*.jsonl' ! -name "$sid.jsonl" -print -quit 2>/dev/null)" ] || continue
    N_PROJECTS_ALL=$((N_PROJECTS_ALL + 1))
    [ -z "$(find "$d" -maxdepth 1 -name '*.jsonl' ! -name "$sid.jsonl" -mmin -4320 -print -quit 2>/dev/null)" ] || N_PROJECTS=$((N_PROJECTS + 1))
  done
  N_REPOS=0
  roots=$("$svc" config get WEEVILS_PROJECTS)
  IFS=: read -ra roots <<<"${roots:-$HOME/projects}"
  for root in ${roots[@]+"${roots[@]}"}; do
    for r in "$root"/*/.git; do [ ! -e "$r" ] || N_REPOS=$((N_REPOS + 1)); done
  done
  HAVE_TS=$(yn command -v tailscale) TS_NAME=''
  [ "$HAVE_TS" = no ] || TS_NAME=$(timeout 5 tailscale status --json 2>/dev/null | jq -r 'select(.BackendState == "Running") | .Self.DNSName // empty' 2>/dev/null | sed 's/\.$//' || true)
  LAPTOP=no
  if ls /sys/class/power_supply/BAT* >/dev/null 2>&1; then LAPTOP=yes; fi
}

# The hand-off file read by the app (its first-run tour starts where the install stopped): written on every successful
# install of a main machine, atomically (temp file in the same folder, then mv). Shape, version 1:
#   { "v": 1, "at": <ms>, "by": "agent"|"terminal"|"script", "agent": "claude"|"codex"|"", "url": <no code>,
#     "mode": "public"|"lan"|"local", "phoneLink": bool, "lang": "fr"|"en",
#     "ready": { "claude": bool, "codex": bool, "gh": bool }, "projects": <n>, "repos": <n> }
# by: agent (--agent or detected), terminal (a human saw the end screen), script (--yes without a terminal).
# phoneLink: the end screen printed a link a phone can open (public or lan; the agent then hands it over).
HANDOFF=$HOME/.local/share/weevils/install.json
write_handoff() { # write_handoff url mode
  local by=script agent='' at tmp phone=false
  if [ "$AGENT" = 1 ]; then by=agent agent=$AGENT_NAME; elif [ "$TTY" = 1 ] || [ -t 1 ]; then by=terminal; fi
  [ "$2" = local ] || phone=true
  at=$(date +%s%3N); [[ "$at" =~ ^[0-9]+$ ]] || at=$(($(date +%s) * 1000))
  mkdir -p "$(dirname "$HANDOFF")"
  tmp=$(mktemp "$HANDOFF.XXXXXX")
  jq -n --argjson at "$at" --arg by "$by" --arg agent "$agent" --arg url "$1" --arg mode "$2" --argjson phone "$phone" \
    --arg lang "$L" --argjson claude "$([ "$CLAUDE_OK" = yes ] && echo true || echo false)" \
    --argjson codex "$([ "$CODEX_OK" = yes ] && echo true || echo false)" --argjson gh "$([ "$GH_OK" = yes ] && echo true || echo false)" \
    --argjson projects "$N_PROJECTS" --argjson repos "$N_REPOS" \
    '{v: 1, at: $at, by: $by, agent: $agent, url: $url, mode: $mode, phoneLink: $phone, lang: $lang,
      ready: {claude: $claude, codex: $codex, gh: $gh}, projects: $projects, repos: $repos}' >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$HANDOFF"
}

# The summary lines every successful install shares (see summary).
sum_found() {
  kv claude_installed "$HAVE_CLAUDE"; kv claude_logged "$CLAUDE_OK"
  kv codex_installed "$HAVE_CODEX"; kv codex_logged "$CODEX_OK"
  kv gh_installed "$HAVE_GH"; kv gh_logged "$GH_OK"; kv gh_login "$GH_LOGIN"
  kv projects "$N_PROJECTS"; kv projects_all "$N_PROJECTS_ALL"; kv repos "$N_REPOS"
  kv tailscale "$HAVE_TS"; kv tailscale_name "$TS_NAME"
  kv laptop "$LAPTOP"; kv wsl "$([ "$IS_WSL" = 1 ] && echo yes || echo no)"
  kv sudo "$(if [ -z "$SUDO" ] || [ "$SUDO" = 'sudo -n' ]; then echo yes; elif [ "$SUDO_PW" = 1 ]; then echo password; else echo no; fi)"
  kv name "$("$DIR/server/weevils-service" config get WEEVILS_USER_NAME)"
  kv dir "$DIR"
}

finish() {
  local svc="$DIR/server/weevils-service" port code url host_cfg mode=local title=ready ip='' try=try_write it=try_new
  port=$("$svc" config get WEEVILS_PORT); port=${port:-4179}
  if ! command -v claude >/dev/null; then title=almost_install
  elif ! claude_logged; then title=almost_login; fi
  detect
  if [ -n "$SECONDARY" ]; then
    step "$(t "$title")"
    ok "$(t secondary_ok) $SECONDARY"
    info "$(t secondary_next)"
    agent_notes
    kv role secondary; kv main_host "$SECONDARY"; sum_found
    summary ok
    return 0
  fi
  step "$(t waiting)"
  local up=0
  for _ in $(seq 1 60); do curl -sf -m 2 "http://127.0.0.1:$port/api/me" >/dev/null 2>&1 && { up=1; break; }; sleep 0.5; done
  [ "$up" = 1 ] || die "$(t down)"
  ok "http://127.0.0.1:$port"

  code=$(cat "$CONF_DIR/secret")
  host_cfg=$("$svc" config get WEEVILS_HOST)
  if [ -n "$DOMAIN" ]; then url=https://$DOMAIN mode=public
  elif [ -n "$("$svc" config get WEEVILS_PUBLIC_URL)" ]; then url=$("$svc" config get WEEVILS_PUBLIC_URL) mode=public
  elif [ -n "$host_cfg" ] && [ "$host_cfg" != 127.0.0.1 ] && [ "$host_cfg" != localhost ]; then
    ip=$(lan_ip); url=http://${ip:-127.0.0.1}:$port mode=lan
  else url=http://localhost:$port; fi
  url=${url%/}
  write_handoff "$url" "$mode"

  step "$(t "$title")"
  printf '\n  %s : %s%s%s\n' "$(t address)" "$B" "$url" "$R"
  printf '  %s : %s%s%s\n' "$(t code)" "$B$M" "$code" "$R"
  printf '  %s : %s\n\n' "$(t link)" "$url/#k=$code"
  if [ "$mode" = local ]; then
    # http://localhost on a phone is the phone itself: no QR code, the ways in instead.
    ip=$(lan_ip)
    info "$(t unreachable)"
    info "  1. $(t via_domain) $DIR/install.sh --domain <host>"
    info "  2. $(t via_tailscale) sudo tailscale serve --bg $port && $DIR/install.sh --url https://${TS_NAME:-<machine>.<tailnet>.ts.net}"
    info "  3. $(t via_lan) $DIR/install.sh --lan"
    info "  4. $(t via_tunnel) ssh -L $port:127.0.0.1:$port ${USER:-$(id -un)}@${ip:-<this-machine>}"
  elif [ "$AGENT" = 0 ]; then
    # (An agent shows the QR code itself, from the link: see AGENTS.md.)
    if command -v qrencode >/dev/null; then qrencode -t ANSIUTF8 -m 2 "$url/#k=$code" | sed 's/^/  /'; echo
    else info "$(t no_qr)"; fi
  fi
  if [ "$mode" = lan ]; then
    [ -z "$ip" ] || private_ip "$ip" || printf '  %s! %s%s\n' "$E$B" "$(t lan_public)" "$R"
    info "$(t lan_https)"
  fi
  [ "$IS_WSL" = 0 ] || warn "$(t wsl)"
  agent_notes
  [ "$LAPTOP" = no ] || info "$(t laptop)"
  if [ "$mode" = local ]; then info "$(t next_local)"; else info "$(t next)"; fi
  # The end: what is already there, and the first thing to try. Voice needs HTTPS (the phone's mic) and a
  # transcription key in the settings; writing works everywhere.
  echo
  if [ "$N_PROJECTS" -gt 1 ]; then star "$(tn have_projects "$N_PROJECTS")"
  elif [ "$N_PROJECTS" = 1 ]; then star "$(t have_project1)"
  elif [ "$N_REPOS" -gt 0 ]; then star "$(tn have_repos "$N_REPOS")"; fi
  [ "$N_PROJECTS" = 0 ] || it=try_projects
  [ "${url#https://}" = "$url" ] || [ -z "$("$svc" config get OPENAI_API_KEY)" ] || try=try_voice
  star "$(t "$try") $(t "$it")"
  echo
  [ "$AGENT" = 0 ] || info "$(t agent_next) $DIR/AGENTS.md"

  kv role main; kv url "$url"; kv code "$code"; kv link "$url/#k=$code"; kv mode "$mode"
  kv https "$([ "${url#https://}" != "$url" ] && echo yes || echo no)"; kv port "$port"
  kv ready "$([ "$title" = ready ] && echo yes || echo no)"
  sum_found
  kv qrencode "$(yn command -v qrencode)"; kv handoff "$HANDOFF"
  kv next "read $DIR/AGENTS.md steps 6 and 7, then write the final message"
  summary ok
}

# ---------------------------------------------------------------- uninstall

# Removes what install.sh put outside the clone: the service, the commands in ~/.local/bin, the weevils hooks in
# ~/.claude/settings.json, the @reboot line, the Caddy site. Settings, access code and data stay unless --purge.
# Nothing here needs the clone: it works from curl | bash too.
uninstall() {
  step "$(t s_uninstall)"
  confirm "$(t ask_uninstall)" || { info "$(t aborted)"; exit 1; }
  local svc=$HOME/.local/bin/weevils-service units=$HOME/.config/systemd/user clone='' site=/etc/caddy/weevils.caddy
  local cf=/etc/caddy/Caddyfile settings=$HOME/.claude/settings.json sudo='' domain='' tmp
  clone=$(sed -n 's/^WEEVILS_DIR=//p' "$CONF_DIR/service.conf" 2>/dev/null | head -1 | tr -d "'\"" || true)

  # Service: stopped through weevils-service (systemd or background), then the units go.
  [ ! -x "$svc" ] || "$svc" stop >/dev/null 2>&1 || true
  if [ -f "$units/weevilsd.service" ] || [ -f "$units/weevils-tunnel.service" ]; then
    export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
    [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] || export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
    systemctl --user disable --now weevilsd weevils-tunnel >/dev/null 2>&1 || true
    rm -f "$units/weevilsd.service" "$units/weevils-tunnel.service"
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  ok "$(t un_service)"

  # Hooks: only the weevils ones; an event left without hooks is dropped, the other hooks stay as they are.
  if [ -f "$settings" ] && command -v jq >/dev/null && jq -e '[.hooks[]?[]?.hooks[]?.command // "" | select(endswith("/weevils-hook"))] | length > 0' "$settings" >/dev/null 2>&1; then
    tmp=$(mktemp)
    jq '.hooks |= (with_entries(.value |= map(.hooks |= map(select((.command // "") | endswith("/weevils-hook") | not)) | select(.hooks | length > 0)))
      | with_entries(select(.value | length > 0)))
      | if .hooks == {} then del(.hooks) else . end' "$settings" >"$tmp" && cat "$tmp" >"$settings"
    rm -f "$tmp"
    ok "$(t un_hooks)"
  fi

  # The public URL came with the Caddy site: it goes with it (read before the commands are removed).
  [ ! -f "$site" ] || domain=$(awk 'index($0, "{") { print $1; exit }' "$site")
  if [ -n "$domain" ] && [ -x "$svc" ] && [ "$("$svc" config get WEEVILS_PUBLIC_URL)" = "https://$domain" ]; then
    "$svc" config set WEEVILS_PUBLIC_URL ''
  fi
  rm -f "$HOME/.local/bin/wv" "$HOME/.local/bin/weevils" "$HOME/.local/bin/weevils-service" "$HOME/.local/bin/weevils-hook"
  ok "$(t un_bin)"

  if command -v crontab >/dev/null && crontab -l 2>/dev/null | grep -q 'weevils-service'; then
    { crontab -l 2>/dev/null | grep -v 'weevils-service' || true; } | crontab - && ok "$(t un_cron)"
  fi

  if site_mine; then
    if [ "$(id -u)" = 0 ]; then sudo=''; elif command -v sudo >/dev/null; then sudo=sudo; else sudo=none; fi
    if [ "$sudo" = none ]; then warn "$(t un_caddy_sudo)"
    else
      $sudo rm -f "$site"
      if [ -f "$cf" ]; then
        $sudo sed -i '\#^[[:space:]]*import[[:space:]]\{1,\}/etc/caddy/weevils.caddy[[:space:]]*$#d' "$cf"
        # A Caddyfile left empty was the package's placeholder, replaced by ours: it comes back.
        if ! grep -q '[^[:space:]]' "$cf" && [ -f "$cf.bak-weevils" ]; then $sudo cp -p "$cf.bak-weevils" "$cf"; fi
      fi
      if [ -d /run/systemd/system ] && systemctl is-active --quiet caddy 2>/dev/null; then $sudo systemctl reload caddy >/dev/null 2>&1 || true
      elif command -v caddy >/dev/null; then $sudo caddy reload --config "$cf" --adapter caddyfile >/dev/null 2>&1 || true; fi
      ok "$(t un_caddy)"
    fi
  fi

  if [ "$PURGE" = 1 ]; then
    rm -rf "$CONF_DIR" "$HOME/.local/share/weevils"
    ok "$(t un_purged)"
  else info "$(t un_kept)"; fi
  [ -z "$clone" ] || info "$(t un_clone) $clone"
  info "$(t un_tmux)"
  step "$(t un_done)"
}

main() {
  [ -z "${HELP:-}" ] || { echo "$(t usage)"; exit 0; }
  [ -z "$BAD_VAL" ] || { echo "$(t bad_opt) $BAD_VAL" >&2; BAD=1; }
  [ -z "${BAD:-}" ] || { echo "$(t usage)" >&2; summary failed "$(t usage)"; exit 2; }
  printf '%s weevils %s %s\n' "$Y$B" "$R" "$(t title)"
  if [ "$UNINSTALL" = 1 ]; then uninstall; exit 0; fi
  # An agent always gets its summary, even when a command fails on the way (set -e).
  trap 'rc=$?; [ "$rc" = 0 ] || summary failed "stopped (exit code $rc): see the lines above"' EXIT
  check_system
  get_source
  configure
  build
  service
  https
  finish
}

main
}

# Everything above is one function definition: nothing runs before the whole script is downloaded and parsed.
_weevils_install
