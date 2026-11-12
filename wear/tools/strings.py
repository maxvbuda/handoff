#!/usr/bin/env python3
# Builds the Wear OS app's strings.xml files from the Apple Watch app's string catalog, so both
# apps say the same thing in every language. Run from the repo root after changing either.
import json, os, re

CATALOG = 'watch/ClaudeNotes/Localizable.xcstrings'
RES = 'wear/app/src/main/res'
FOLDERS = {'en': 'values', 'pl': 'values-pl', 'es': 'values-es', 'fr': 'values-fr', 'de': 'values-de', 'it': 'values-it',
           'pt-BR': 'values-pt-rBR', 'ja': 'values-ja', 'zh-Hans': 'values-b+zh+Hans'}

# Android name -> the English string the Apple Watch app uses as its key.
NAMES = {
    'accept_suggestion': 'Accept suggestion', 'add_a_line': 'Add a line…', 'allow': 'Allow', 'any_chat': 'Any chat',
    'background': 'Background', 'blue': 'Blue', 'chat_name': 'Chat name', 'claude_asks': 'Claude asks',
    'claude_asks_from': 'Claude asks · %@', 'clay': 'Clay', 'code_expired': 'This code expired.', 'color': 'Color',
    'couldnt_reach_mac': "Couldn't reach your Mac", 'couldnt_reach_mac_retry': "Couldn't reach your Mac. Try again.",
    'delete': 'Delete', 'delete_all_history': 'Delete All History', 'delete_all_history_q': 'Delete all history?',
    'delete_all_history_message': 'Clears the Handed off list on this watch. Notes still waiting to send are kept.',
    'delivered': 'Delivered', 'deny': 'Deny', 'details': 'Details', 'dismiss': 'Dismiss', 'every_day': 'Every day',
    'every_day_at': 'Every day at %@', 'every_hour': 'Every hour', 'every_hour_at': 'Every hour at :%@', 'folders': 'Folders',
    'graphite': 'Graphite', 'green': 'Green', 'handed_off': 'Handed off', 'ideas': 'Ideas', 'idle': 'Idle',
    'jot_an_idea': 'Jot an idea…', 'mac_didnt_answer': "Your Mac didn't answer. Is handoff host running?",
    'makes_folder_first': 'Makes the folder %@ first.', 'minute_past': 'Minute past', 'name_chat': 'Name chat', 'new_': 'New',
    'new_chat': 'New chat', 'new_code': 'New code', 'new_folder': 'New folder…', 'no_chats': 'No chats are open.',
    'no_folders': 'No folders', 'open_on_computer': 'Open on computer', 'opened_on_mac': 'Opened on your Mac', 'pair': 'Pair',
    'pair_instructions': 'On your Mac, run handoff pair and type this code:', 'pink': 'Pink', 'projects': 'Projects',
    'purple': 'Purple', 'quick_reply': 'Quick reply', 'recurring': 'Recurring', 'recurring_count': 'Recurring (%lld)',
    'relay_busy': 'The relay is busy. Try again in a minute.', 'relay_unreachable': "Couldn't reach the relay. Check your connection.",
    'repeat': 'Repeat', 'save': 'Save', 'send_to_claude': 'Send to Claude', 'settings': 'Settings', 'start_chat': 'Start chat',
    'start_chat_here': 'Start chat here', 'starting': 'Starting…', 'suggestion': 'Suggestion', 'suggestion_from': 'Suggestion · %@',
    'suggestions': 'Suggestions', 'suggestions_footer': "Show Claude's suggested next step when it finishes a note.",
    'time': 'Time', 'to': 'To', 'to_chat': '→ %@', 'unpair': 'Unpair', 'unpair_q': 'Unpair from your Mac?',
    'unpair_message': "You'll need to run pair on your Mac again.", 'use_tool': 'Use %@', 'waiting_for_mac': 'Waiting for your Mac…',
    'waiting_to_send': 'Waiting to send', 'weekdays': 'Weekdays', 'weekdays_at': 'Weekdays at %@',
    'what_should_claude_do': 'What should Claude do?', 'yellow': 'Yellow',
    'recurring_footer': 'Your Mac runs these while a handoff start or handoff host is open. Swipe to delete.',
}
# Only on Wear OS (the tile), with plural forms per language.
WAITING = {
    'en': {'one': '%d note waiting to send', 'other': '%d notes waiting to send'},
    'pl': {'one': '%d notatka czeka na wysłanie', 'few': '%d notatki czekają na wysłanie',
           'many': '%d notatek czeka na wysłanie', 'other': '%d notatki czeka na wysłanie'},
    'es': {'one': '%d nota por enviar', 'other': '%d notas por enviar'},
    'fr': {'one': "%d note en attente d'envoi", 'other': "%d notes en attente d'envoi"},
    'de': {'one': '%d Notiz wartet auf Versand', 'other': '%d Notizen warten auf Versand'},
    'it': {'one': '%d nota da inviare', 'other': '%d note da inviare'},
    'pt-BR': {'one': '%d nota aguardando envio', 'other': '%d notas aguardando envio'},
    'ja': {'other': '送信待ち %d 件'},
    'zh-Hans': {'other': '%d 条待发送'},
}
# Android has no swipe-to-delete in this list: you tap a recurring note to delete it.
WEAR_ONLY = {'recurring_footer': {
    'en': 'Your Mac runs these while a handoff start or handoff host is open. Tap one to delete it.',
    'pl': 'Mac uruchamia je, gdy działa handoff start lub handoff host. Stuknij, aby usunąć.',
    'es': 'Tu Mac las ejecuta mientras haya un handoff start o handoff host abierto. Toca una para eliminarla.',
    'fr': 'Votre Mac les lance tant qu’un handoff start ou handoff host est ouvert. Touchez-en une pour la supprimer.',
    'de': 'Dein Mac führt sie aus, solange handoff start oder handoff host läuft. Zum Löschen antippen.',
    'it': 'Il Mac le esegue mentre è aperto handoff start o handoff host. Tocca per eliminarla.',
    'pt-BR': 'Seu Mac as executa enquanto um handoff start ou handoff host estiver aberto. Toque em uma para apagar.',
    'ja': 'handoff start か handoff host が開いている間、Mac が実行します。タップで削除。',
    'zh-Hans': '在 handoff start 或 handoff host 运行时由 Mac 执行。轻点可删除。',
}}

def esc(s):
    s = s.replace('%lld', '%d').replace('%@', '%s')
    n = 0
    def number(m):
        nonlocal n; n += 1
        return f'%{n}${m.group(1)}'
    s = re.sub(r'%([sd])', number, s)
    s = s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace("'", "\\'").replace('"', '\\"')
    return '\\' + s if s[:1] in '@?' else s

cat = json.load(open(CATALOG))['strings']
for lang, folder in FOLDERS.items():
    out = ['<?xml version="1.0" encoding="utf-8"?>', '<!-- Made by wear/tools/strings.py from ' + CATALOG + '. Don\'t edit by hand. -->', '<resources>']
    if lang == 'en': out.append('    <string name="app_name" translatable="false">Hand-Off</string>')
    for name, key in sorted(NAMES.items()):
        if name in WEAR_ONLY: text = WEAR_ONLY[name][lang]
        elif lang == 'en': text = key
        elif 'localizations' not in cat[key]: continue  # the same in every language ("→ %@")
        else: text = cat[key]['localizations'][lang]['stringUnit']['value']
        out.append(f'    <string name="{name}">{esc(text)}</string>')
    out.append('    <plurals name="waiting_count">')
    for q, t in WAITING[lang].items(): out.append(f'        <item quantity="{q}">{esc(t)}</item>')
    out += ['    </plurals>', '</resources>', '']
    os.makedirs(f'{RES}/{folder}', exist_ok=True)
    open(f'{RES}/{folder}/strings.xml', 'w').write('\n'.join(out))
print('ok')
