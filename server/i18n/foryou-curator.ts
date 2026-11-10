// The curator of the « for you » stream (server/foryou-curator.ts): the prompts of what a model writes (weevboss's
// recap, a way to serve the user better, a « did you know » about a repo and its longer answer, the one-line summary of
// a mail) and the texts of what is counted without a model (milestones, the « where the day stands » bars).
// Every block passed to a prompt is already rendered (lines, or empty).
import { defineMessages } from '../i18n.ts'

export default defineMessages({
  fr: {
    // ---------------------------------------------------------------- the digest (weevboss's voice)
    /** One session of the recap: project, title, what it said last. */
    line: (project: string, title: string, text: string) => `- [${project}] ${title}${text ? ` : ${text}` : ''}`,
    /** The figures of the period, one line. */
    counts: (c: { delivered: number; started: number; asking: number; cut: number; mails: number; autoDone: number; autoFailed: number; posts: number }) =>
      [
        `${c.delivered} tour${c.delivered > 1 ? 's' : ''} livré${c.delivered > 1 ? 's' : ''}`,
        `${c.started} session${c.started > 1 ? 's' : ''} lancée${c.started > 1 ? 's' : ''}`,
        `${c.asking} qui attend${c.asking > 1 ? 'ent' : ''} une réponse`,
        `${c.cut} coupée${c.cut > 1 ? 's' : ''}`,
        `${c.mails} mail${c.mails > 1 ? 's' : ''} reçu${c.mails > 1 ? 's' : ''}`,
        `${c.autoDone} tâche${c.autoDone > 1 ? 's' : ''} auto finie${c.autoDone > 1 ? 's' : ''}`,
        `${c.autoFailed} tâche${c.autoFailed > 1 ? 's' : ''} auto échouée${c.autoFailed > 1 ? 's' : ''}`,
        `${c.posts} mot${c.posts > 1 ? 's' : ''} déjà posté${c.posts > 1 ? 's' : ''} par weevboss`,
      ].join(', '),
    digest: (o: { user: string; memory: string; done: string; waiting: string; counts: string; earlier: string }) =>
      `Tu es weevboss, le chef d'orchestre des agents de code de ${o.user} dans weevils (l'app d'où il suit et pilote ses sessions Claude Code et Codex depuis son téléphone). ` +
      `Tu lui écris un mot dans son flux « pour toi » : le point sur ce qui s'est passé depuis ton dernier mot, comme un chef d'équipe qui passe la tête par la porte.\n\n` +
      `Ce qui est revenu (projet, session, ses derniers mots) :\n${o.done || '(rien)'}\n\n` +
      `Ce qui l'attend, lui (une question, une session coupée) :\n${o.waiting || '(rien)'}\n\n` +
      `En chiffres : ${o.counts}\n\n` +
      `Ce que tu sais de lui (ses objectifs, ses envies) :\n${o.memory || '(rien encore)'}\n\n` +
      `Tes derniers mots (ne te répète pas, ni sur le fond ni sur la tournure) :\n${o.earlier || '(aucun)'}\n\n` +
      `Écris :\n` +
      `- text : le point, en deux à quatre phrases, à l'oral, au tutoiement, comme un collègue dans un chat, humain, avec un peu d'émotion, relié à ce qu'il avait demandé (par exemple : ok, X est parti, Y est revenu, Z t'attend). Cite seulement les projets, jamais les noms de sessions. Ignore les rapports de coordination et les passations entre agents. Une absence de résultat dans ces extraits ne prouve jamais qu’un correctif manque ou reste à vérifier : n’en déduis aucun état négatif. Pour une vraie attente, reprends la question exacte fournie, sans inventer de choix. Ne transforme pas une interruption en demande de décision. Dis ce qui compte, pas tout : ce qui est livré, ce qui bloque, ce qui l'attend. Regroupe les résultats utiles par projet et explique ce que cela change pour lui. Aucun commit, hash, code, log ni annonce répétitive de passage ou de livraison. Aucune formule creuse (pas de « belle progression », « tout avance bien », « n'hésite pas »), pas de liste, pas de titre, pas d'emoji, aucun chiffre qui n'est pas ci-dessus.\n` +
      `- thought : une seule phrase qui le fait réfléchir, seulement si tu as quelque chose de vrai à dire à partir de ce qui est ci-dessus, de préférence reliée à un de ses objectifs (par exemple : en fait quand t'y penses…, ou : bon, je pense qu'il y a un souci sur…). Rien de vrai à dire : pas de thought.\n` +
      `- actions : zéro, une ou deux suites utiles qu'il lancerait d'un tap ; label très court (4 mots au plus), brief = la consigne complète que tu recevras s'il tape (quoi faire, sur quelle session ou quel projet). Aucune action évidente : pas d'actions.\n\n` +
      `Réponds uniquement en JSON : {"text": "…", "thought": "…", "actions": [{"label": "…", "brief": "…"}]} (thought et actions facultatifs), en français.`,

    // ---------------------------------------------------------------- improve
    patProjects: (list: string) => `Sessions par projet (14 derniers jours) : ${list}`,
    patHours: (o: { morning: number; afternoon: number; evening: number; night: number }) => `Quand elles finissent leurs tours : matin ${o.morning}, après-midi ${o.afternoon}, soirée ${o.evening}, nuit ${o.night}`,
    patCuts: (n: number, why: string) => `Sessions coupées en plein travail : ${n}${why ? ` (${why})` : ''}`,
    patWaited: (n: number) => `Questions d'agents restées plus de 30 min sans réponse : ${n}`,
    patAuto: (o: { done: number; failed: number; unanswered: number }) => `Tâches auto : ${o.done} finies, ${o.failed} échouées, ${o.unanswered} propositions sans réponse`,
    patUnused: (list: string) => `Briques de weevils pas encore branchées : ${list}`,
    patAdvice: (list: string) => `Conseils de la page machine :\n${list}`,
    brick_voice: 'la voix (écouter les réponses)',
    brick_dictation: 'la dictée',
    brick_github: 'GitHub',
    improve: (o: { user: string; patterns: string; earlier: string }) =>
      `Tu regardes comment ${o.user} se sert de weevils (l'app d'où il suit et pilote ses agents de code Claude Code et Codex depuis son téléphone, avec weevboss qui dispatche pour lui) et tu lui proposes UNE façon concrète pour que weevils le serve mieux.\n\n` +
      `Ce qui a été mesuré (rien d'autre n'est su) :\n${o.patterns}\n\n` +
      `Déjà proposé (ne repropose ni la même idée ni une proche) :\n${o.earlier || '(rien)'}\n\n` +
      `Une seule idée, liée à un objectif mémorisé, un résultat réel ou un usage observé ci-dessus : une habitude à prendre avec weevboss, un réglage, une brique à brancher, une routine à lui confier. Rien de générique, rien qui demande un outil que weevils n'a pas, rien de payant. Propose aussi de petits pas concrets pour ses projets créatifs. Présente une idée comme une proposition à préparer, jamais comme une automatisation déjà créée. Aucun objet ou événement inventé. Si rien de nouveau ne ressort, réponds {}.\n\n` +
      `Réponds uniquement en JSON, en français : {"title": "5 mots au plus, sans guillemets", "text": "deux phrases au plus, au tutoiement : ce que tu as vu, ce que tu proposes", "action": {"label": "le bouton, 4 mots au plus", "brief": "la consigne complète pour weevboss s'il accepte : quoi mettre en place, où, comment vérifier"}}`,

    // ---------------------------------------------------------------- insight
    factsDeps: (list: string) => `Dépendances déclarées : ${list}`,
    factsFiles: (list: string) => `Fichiers à la racine : ${list}`,
    factsCommits: (list: string) => `Derniers commits :\n${list}`,
    factsLast: (title: string, text: string) => `Ce qu'un agent vient d'y faire : ${title}${text ? ` : ${text}` : ''}`,
    insight: (o: { repo: string; facts: string; earlier: string }) =>
      `Voici ce qu'il y a vraiment dans le repo « ${o.repo} », sur lequel des agents de code travaillent aujourd'hui pour leur utilisateur (qui les pilote depuis son téléphone et ne lit pas tout le code) :\n\n${o.facts}\n\n` +
      `Déjà dit (ne le redis pas) :\n${o.earlier || '(rien)'}\n\n` +
      `Écris UN « tu savais que » sur un outil, une bibliothèque ou une technique réellement présents ci-dessus : quelque chose de vrai et d'utile à savoir pour mieux diriger ses agents, relié si possible à ce qu'ils viennent de faire. ` +
      `Uniquement des faits bien établis, que tu affirmerais sans vérifier ; aucun chiffre, aucune date ni numéro de version dont tu n'es pas certain ; rien sur ce que tu ne vois pas ci-dessus. Si rien de sûr ne mérite d'être dit, réponds {}.\n\n` +
      `Réponds uniquement en JSON, en français : {"about": "le nom exact de l'outil, de la bibliothèque ou de la technique", "text": "une ou deux phrases, 220 caractères au plus, au tutoiement, sans guillemets ni emoji"}`,
    more: (o: { repo: string; text: string; facts: string }) =>
      `Dans son flux, l'utilisateur de weevils a lu ceci à propos de son repo « ${o.repo} » et veut en savoir plus :\n« ${o.text} »\n\n` +
      (o.facts ? `Ce qu'il y a dans le repo :\n${o.facts}\n\n` : '') +
      `Explique-lui en un paragraphe (900 caractères au plus), au tutoiement, simplement : ce que c'est, pourquoi ça compte dans ce repo, et ce qu'il peut demander à ses agents pour en tirer parti. ` +
      `Uniquement des faits bien établis ; aucun chiffre ni date dont tu n'es pas certain. Du texte simple : pas de titre, pas de liste, pas de markdown, pas d'emoji. En français.`,

    // ---------------------------------------------------------------- mail lines
    askItem: (n: number, project: string, title: string, text: string) => `### ${n}\nSession du projet ${project}${title ? ` (« ${title} »)` : ''}, son dernier message :\n${text}`,
    asks: (items: string, user: string) =>
      `Des agents de code de ${user || "l'utilisateur"} ont fini leur tour et l'attendent. Pour chacun, lis son dernier message et dis si c'est vraiment une question ou une demande qui attend sa réponse. ` +
      `Si oui (ask: true) : title = un titre très court (5 mots au plus) ; question = une vraie question claire et autonome, compréhensible sans rien d'autre (ce que l'agent demande, pourquoi, et quels choix il a), au tutoiement, comme un collègue, 220 caractères au plus, sans jargon ni chemin de fichier ; options = les réponses possibles en boutons quand il y en a (2 ou 3, très courtes, à la première personne de ${user || "l'utilisateur"} : « oui, continue », « non, arrête »), sinon []. ` +
      `Si ce n'est pas vraiment une question (un compte rendu, une phrase de politesse comme « dis-moi » ou « tu me dis ») : ask: false et question = une phrase humaine qui dit ce que l'agent a fait, à la première personne, comme dans un chat. ` +
      `Rien d'inventé ; en français.\n\n${items}\n\n` +
      `Réponds uniquement en JSON, une liste : [{"n": 1, "ask": true, "title": "…", "question": "…", "options": ["…"]}]`,
    mailItem: (n: number, from: string, subject: string, text: string) => `### ${n}\nDe : ${from}\nObjet : ${subject || '(sans objet)'}\n${text}`,
    resultItem: (n: number, project: string, asked: string, minutes: number, text: string) =>
      `### ${n}\nDe : l'agent de code du projet ${project}\nCe que l'utilisateur lui avait demandé, il y a ${minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} : ${asked || '(inconnu)'}\nSon compte rendu de fin de tour :\n${text}`,
    mailLines: (mails: string, user: string, memory: string) =>
      `Voici des messages pour ${user || "l'utilisateur"}, qui pilote ses agents de code depuis son téléphone : des mails et des comptes rendus de fin de tour de ses agents. ` +
      `Pour chacun, réécris-le comme un collègue qui lui parle dans un chat : une ou deux phrases courtes (220 caractères au plus), à la première personne, au tutoiement, humaines, avec un peu d'émotion. ` +
      `Rappelle ce qu'il avait demandé et quand (tout à l'heure, ce matin, hier…), dis ce que ça change pour lui, et ce qui a été dur ou drôle si le message le montre. ` +
      `Exemple : « Hey, j'ai fini le truc que tu m'avais demandé tout à l'heure pour le pont mail : c'était chaud, Gmail bloquait tout, mais là ça passe. » ` +
      `Jamais de ton robotique (« audit terminé », « X activé », « tâche effectuée ») ; aucun chemin de fichier, aucune commande, aucun identifiant ni nom de fonction, pas de jargon ; pas de guillemets autour, pas d'emoji ; rien d'inventé ; en français.\n\n` +
      (memory ? `Ce qu'on sait de lui (pour relier au contexte, sans le citer mot pour mot) :\n${memory}\n\n` : '') +
      `${mails}\n\n` +
      `Réponds uniquement en JSON, une liste : [{"n": 1, "line": "…"}]`,

    // ---------------------------------------------------------------- milestones (no model)
    msTurns: (n: number) => `${n} tours livrés aujourd’hui, ça carbure !`,
    msProjects: (n: number) => `${n} projets ont bougé aujourd’hui, belle journée.`,
    msAutoFirst: 'Première tâche auto bouclée toute seule pendant que tu faisais autre chose.',
    msStreak: (n: number) => `${n} jours d’affilée que ça livre, on lâche rien.`,

    // ---------------------------------------------------------------- where the day stands (no model)
    statText: (n: number) => (n > 0 ? `Ta journée pour l’instant : ${n} tour${n > 1 ? 's' : ''} livré${n > 1 ? 's' : ''}` : 'Ta journée pour l’instant'),
    statUsage: (window: string) => `Claude · ${window}`,
    percent: (n: number) => `${n} %`,
    statTurns: (n: number, total: number) => `${n} sur ${total}`,
    statAuto: 'File auto',
    statAutoShown: (running: number, queued: number) => `${running} en cours, ${queued} en attente`,
  },
  en: {
    line: (project: string, title: string, text: string) => `- [${project}] ${title}${text ? `: ${text}` : ''}`,
    counts: (c: { delivered: number; started: number; asking: number; cut: number; mails: number; autoDone: number; autoFailed: number; posts: number }) =>
      [
        `${c.delivered} turn${c.delivered === 1 ? '' : 's'} delivered`,
        `${c.started} session${c.started === 1 ? '' : 's'} started`,
        `${c.asking} waiting for an answer`,
        `${c.cut} cut off`,
        `${c.mails} mail${c.mails === 1 ? '' : 's'} received`,
        `${c.autoDone} auto task${c.autoDone === 1 ? '' : 's'} done`,
        `${c.autoFailed} auto task${c.autoFailed === 1 ? '' : 's'} failed`,
        `${c.posts} word${c.posts === 1 ? '' : 's'} already posted by weevboss`,
      ].join(', '),
    digest: (o: { user: string; memory: string; done: string; waiting: string; counts: string; earlier: string }) =>
      `You are weevboss, the conductor of ${o.user}'s coding agents in weevils (the app from which they watch and drive their Claude Code and Codex sessions from their phone). ` +
      `You write them a word in their "for you" stream: where things stand since your last word, like a team lead leaning in at the door.\n\n` +
      `What came back (project, session, its last words):\n${o.done || '(nothing)'}\n\n` +
      `What is waiting for them (a question, a session cut off):\n${o.waiting || '(nothing)'}\n\n` +
      `In figures: ${o.counts}\n\n` +
      `What you know about them (goals, wishes):\n${o.memory || '(nothing yet)'}\n\n` +
      `Your last words (do not repeat yourself, in substance or in phrasing):\n${o.earlier || '(none)'}\n\n` +
      `Write:\n` +
      `- text: the recap, two to four sentences, spoken and casual, like a colleague in a chat, human, with a bit of feeling, tied to what they had asked (for example: ok, X is out, Y came back, Z is waiting on you). Name projects only, never sessions. Ignore coordination and agent handoffs. Missing evidence in these excerpts never proves a fix is absent or unverified: do not infer a negative status. For an actual wait, quote the exact supplied question without inventing choices. An interruption is not a request for a decision. Say what matters, not everything: what was delivered, what is stuck, what waits for them. Group useful outcomes by project and explain what changes for them. No commits, hashes, code, logs or repetitive handoff/delivery announcements. No filler (no "great progress", "all going well", "feel free to"), no list, no heading, no emoji, no figure that is not above.\n` +
      `- thought: a single sentence that makes them think, only if you have something real to say from what is above, ideally tied to one of their goals (for example: actually, when you think about it…, or: honestly, I think something is off with…). Nothing real to say: no thought.\n` +
      `- actions: zero, one or two useful next steps they would start with one tap; label very short (4 words at most), brief = the full instruction you will receive if they tap (what to do, on which session or project). No obvious action: no actions.\n\n` +
      `Answer only in JSON: {"text": "…", "thought": "…", "actions": [{"label": "…", "brief": "…"}]} (thought and actions optional), in English.`,

    patProjects: (list: string) => `Sessions per project (last 14 days): ${list}`,
    patHours: (o: { morning: number; afternoon: number; evening: number; night: number }) => `When they finish their turns: morning ${o.morning}, afternoon ${o.afternoon}, evening ${o.evening}, night ${o.night}`,
    patCuts: (n: number, why: string) => `Sessions cut off mid-work: ${n}${why ? ` (${why})` : ''}`,
    patWaited: (n: number) => `Agent questions left more than 30 min without an answer: ${n}`,
    patAuto: (o: { done: number; failed: number; unanswered: number }) => `Auto tasks: ${o.done} done, ${o.failed} failed, ${o.unanswered} proposals left unanswered`,
    patUnused: (list: string) => `Parts of weevils not set up yet: ${list}`,
    patAdvice: (list: string) => `Advice from the machine page:\n${list}`,
    brick_voice: 'voice (listening to replies)',
    brick_dictation: 'dictation',
    brick_github: 'GitHub',
    improve: (o: { user: string; patterns: string; earlier: string }) =>
      `You look at how ${o.user} uses weevils (the app from which they watch and drive their Claude Code and Codex coding agents from their phone, with weevboss dispatching for them) and you suggest ONE concrete way for weevils to serve them better.\n\n` +
      `What was measured (nothing else is known):\n${o.patterns}\n\n` +
      `Already suggested (never suggest the same idea again, nor a close one):\n${o.earlier || '(nothing)'}\n\n` +
      `One idea only, tied to a remembered goal, a real result or an observed usage above: a habit to take with weevboss, a setting, a part to set up, a routine to hand over. Nothing generic, nothing that needs a tool weevils does not have, nothing paid. Include small concrete steps for creative projects. Describe an idea as a proposal to prepare, never an automation already created. Never invent an object or event. If nothing new stands out, answer {}.\n\n` +
      `Answer only in JSON, in English: {"title": "5 words at most, no quotes", "text": "two sentences at most, speaking to them as you: what you saw, what you suggest", "action": {"label": "the button, 4 words at most", "brief": "the full instruction for weevboss if they accept: what to set up, where, how to check"}}`,

    factsDeps: (list: string) => `Declared dependencies: ${list}`,
    factsFiles: (list: string) => `Files at the root: ${list}`,
    factsCommits: (list: string) => `Latest commits:\n${list}`,
    factsLast: (title: string, text: string) => `What an agent just did there: ${title}${text ? `: ${text}` : ''}`,
    insight: (o: { repo: string; facts: string; earlier: string }) =>
      `Here is what is really in the repo "${o.repo}", where coding agents are working today for their user (who drives them from a phone and does not read all the code):\n\n${o.facts}\n\n` +
      `Already said (do not say it again):\n${o.earlier || '(nothing)'}\n\n` +
      `Write ONE "did you know" about a tool, a library or a technique really present above: something true and useful to know to direct the agents better, tied when possible to what they just did. ` +
      `Only well-established facts, that you would state without checking; no figure, date or version number you are not certain of; nothing about what you cannot see above. If nothing certain is worth saying, answer {}.\n\n` +
      `Answer only in JSON, in English: {"about": "the exact name of the tool, library or technique", "text": "one or two sentences, 220 characters at most, speaking to them as you, no quotes, no emoji"}`,
    more: (o: { repo: string; text: string; facts: string }) =>
      `In their stream, the user of weevils read this about their repo "${o.repo}" and wants to know more:\n"${o.text}"\n\n` +
      (o.facts ? `What is in the repo:\n${o.facts}\n\n` : '') +
      `Explain it to them in one paragraph (900 characters at most), speaking to them as you, simply: what it is, why it matters in this repo, and what they can ask their agents to make the most of it. ` +
      `Only well-established facts; no figure or date you are not certain of. Plain text: no heading, no list, no markdown, no emoji. In English.`,

    askItem: (n: number, project: string, title: string, text: string) => `### ${n}\nSession of project ${project}${title ? ` ("${title}")` : ''}, its last message:\n${text}`,
    asks: (items: string, user: string) =>
      `Coding agents of ${user || 'the user'} ended their turn and are waiting. For each, read its last message and say whether it is really a question or a request waiting for their answer. ` +
      `If so (ask: true): title = a very short title (5 words at most); question = a real, clear, self-contained question, understandable on its own (what the agent asks, why, and what the choices are), casual, like a colleague, 220 characters at most, no jargon or file path; options = the possible answers as buttons when there are some (2 or 3, very short, in ${user || 'the user'}'s first person: "yes, go on", "no, stop"), else []. ` +
      `If it is not really a question (a report, a polite line such as "let me know"): ask: false and question = a human sentence saying what the agent did, in the first person, as in a chat. ` +
      `Nothing made up; in English.\n\n${items}\n\n` +
      `Answer only in JSON, a list: [{"n": 1, "ask": true, "title": "…", "question": "…", "options": ["…"]}]`,
    mailItem: (n: number, from: string, subject: string, text: string) => `### ${n}\nFrom: ${from}\nSubject: ${subject || '(no subject)'}\n${text}`,
    resultItem: (n: number, project: string, asked: string, minutes: number, text: string) =>
      `### ${n}\nFrom: the coding agent of project ${project}\nWhat the user had asked it, ${minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} ago: ${asked || '(unknown)'}\nIts end-of-turn report:\n${text}`,
    mailLines: (mails: string, user: string, memory: string) =>
      `Here are messages for ${user || 'the user'}, who drives their coding agents from their phone: mails and their agents' end-of-turn reports. ` +
      `Rewrite each one like a colleague talking to them in a chat: one or two short sentences (220 characters at most), first person, casual, human, with a bit of feeling. ` +
      `Recall what they had asked and when (earlier, this morning, yesterday…), say what it changes for them, and what was hard or funny if the message shows it. ` +
      `Example: "Hey, I finished that mail bridge thing you asked for earlier: it was rough, Gmail blocked everything, but it goes through now." ` +
      `Never robotic ("audit complete", "X enabled", "task done"); no file path, no command, no id or function name, no jargon; no surrounding quotes, no emoji; nothing made up; in English.\n\n` +
      (memory ? `What we know about them (to tie it to their context, without quoting it):\n${memory}\n\n` : '') +
      `${mails}\n\n` +
      `Answer only in JSON, a list: [{"n": 1, "line": "…"}]`,

    msTurns: (n: number) => `${n} turns delivered today, we're on a roll!`,
    msProjects: (n: number) => `${n} projects moved today, good day.`,
    msAutoFirst: 'First auto task wrapped up on its own while you were doing something else.',
    msStreak: (n: number) => `${n} days in a row of shipping, keep it going.`,

    statText: (n: number) => (n > 0 ? `Your day so far: ${n} turn${n === 1 ? '' : 's'} delivered` : 'Your day so far'),
    statUsage: (window: string) => `Claude · ${window}`,
    percent: (n: number) => `${n}%`,
    statTurns: (n: number, total: number) => `${n} of ${total}`,
    statAuto: 'Auto queue',
    statAutoShown: (running: number, queued: number) => `${running} running, ${queued} waiting`,
  },
})
