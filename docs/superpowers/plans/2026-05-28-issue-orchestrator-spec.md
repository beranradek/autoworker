# Issues orchestration flow

# Issues data and service model

Issues a jejich stavy by měly být reprezentovány abstraktním modelem, který bude možné snadno aplikovat jak na issue v githubu, tak na issue v gitlabu, tak na issue v Jira.

Model by měl reprezentovat následující stavy pro issues:

closed - s důvodem uzavření completed, not_planned (will not fix), duplicate

pr_reviewed - pull request byl zrevidován a schválen - implementačně může být realizováno pomocí labelu

pr_created - issue bylo implementováno – byl vytvořen pull request a prolinkován s issue - implementačně může být realizováno pomocí labelu

in_progress - implementačně může být realizováno pomocí labelu

open - initial state of issue

Pouze issue označená v description pomocí mention bot loginu `@worker` budou dohledávána a zpracovávána.

K issue musí být jednoznačně dohledatelný linkovaný pull request.

# Issues orchestrator flow

Chci rozšířit task polling server, aby v rámci jednoho cyklu spouštěného cronem pracoval po těchto krocích a vždy všechny tyto kroky postupně vykonal v rámci jednoho cyklu:

Zaprvé: PR_MERGE step: Pokud existují pr_reviewed issues, zamergují se jejich pull requesty a issues se uzavřou s příslušným důvodem.

Za druhé PR_REVIEW step: pokud existují pr_created issues, spustí se separátní Worker který bude realizovat review pull requestu - bude mu předána identifikace pull requestu a jeho git diff a zdrojového issue a description issue, git větev vytvořená pro pull request. PR review Worker dostane v kontejneru naklonované repository s příslušnou větví pull requestu, která má potenciál být namegována do hlavní větve. Worker provede review PR a také případné zápisové opravy s následným commitem a pushem (commit a push se pro detekované změny provedou programově) a vrátí strukturovany výstup - PR schválen, nebo zamítne pull request s důvodem, nebo označí pull request jako human_needed a issue se převede pak do stavu pr_reviewed s připnutím stavu schválení (nebo také s human_needed). Podle toho se v předchozím PR_MERGE kroku issue uzavře s odpovídajícím důvodem, anebo zůstává issue a PR otevřený s human_needed. Taková issues už dále nejsou zpracovávána.

Za třetí: IMPLEMENTATION step: pokud existují open issue, spustí se pro každé implementující Worker, tak jak to v implementaci funguje už nyní. Issue se hned převede do stavu in_progress - taková issue nejsou nabírána v předchozích krocích.

Jednotlivé Steps PR_MERGE, PR_REVIEW, IMPLEMENTATION bude deterministický orchestrátor implementovat v tomto zmíněném pořadí v rámci svého jednoho cyklu. Každý krok bude konfigurovatelný – aplikace bude moci být nastavena tak, že budou enabled - automatizovaně vykonávány jen vybrané kroky - defaultně IMPLEMENTATION a PR_REVIEW bude nastavené na true, PR_MERGE na false. Celkově tak bude pokrytý celý cyklus vývoje softwaru a orchestrátor bude moci být nastaven tak, aby celý proces byl plně automatizovaný.

Získávání seznamů issues a jejich stavů/labelů bude mít abstraktní servisní logiku. Reálně bude nyní implementováno pouze pro github, ale v budoucnosti bude moci být rozšířená implementace také pro gitlab nebo pro něco jiného.








