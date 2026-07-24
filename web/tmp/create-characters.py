"""直接在 SQLite 中创建 3 名女性角色实体，绕过 plan 工作流的 project-positioning 循环。"""
import sqlite3
import json
import uuid
import time

DB = r'C:\Users\admin\AppData\Local\Ymcp\novel-runtime.sqlite'
PROJECT_ID = '99328e42-f08b-49ac-b867-67690963b2e7'

db = sqlite3.connect(DB)
c = db.cursor()

# 检查已有角色
c.execute("SELECT id, payload FROM novel_records WHERE collection='entities' AND project_id=?", (PROJECT_ID,))
existing = c.fetchall()
print(f"existing entities: {len(existing)}")
for row in existing:
    e = json.loads(row[1])
    print(f"  {e.get('name')} (kind={e.get('kind')})")

# 3 名新角色
now = int(time.time() * 1000)
characters = [
    {
        "id": str(uuid.uuid4()),
        "kind": "character",
        "name": "苏锦瑟",
        "aliases": ["锦瑟", "苏侍郎之女"],
        "biography": "大衍王朝礼部侍郎苏慎言之女，出身书香世家，自幼受良好教育。表面端庄守礼，实则在父亲幕僚指导下熟读律法、通晓政务。因父亲卷入朝堂灵气立法之争，她主动参与斡旋，与陈墨在灵气秩序立法听证会上初次交锋。她既有大家闺秀的涵养，又有政治家的务实，是朝堂线中最早意识到灵气编程对王朝秩序双重影响的人物。",
        "personality": "外表端庄冷漠，内心炽热且有主见。处事公允而果决，不轻易表露情感。在政务面前理性至上，在私下里却渴望被理解。有强烈的家国情怀，认为灵气秩序关系到大衍王朝百年基业。",
        "appearance": "容貌清丽，气质高雅。常着素色襦裙，发髻端庄，佩玉簪。眉目间有一种不怒自威的端庄感，但偶尔展露的笑容如春日暖阳。",
        "abilities": "不通修炼，但精通律法、典籍与政务斡旋。擅长言辞交锋与利益平衡，能在朝堂多方势力间找到妥协点。对灵气秩序的法律规制有独到见解。",
        "motivation": "维护大衍王朝的秩序与稳定，同时证明女子亦能在朝堂有所作为。对陈墨的灵气编程既好奇其创新，又警惕其对现有秩序的冲击。",
        "arc": "从'维护旧秩序的守门人'逐渐转变为'新秩序的共建者'。起初试图将灵气编程纳入王朝律法框架约束，后在与陈墨的多次合作中认识到创新与秩序可以共存，最终成为灵气新秩序立法的推动者。",
        "relations": {"陈墨": "朝堂对手→合作者→暧昧对象", "苏慎言": "父亲，礼部侍郎"},
        "faction": "朝堂",
        "romanceArchetype": "高贵端庄型：外表冷漠内心炽热，家国情怀与个人抱负的张力",
    },
    {
        "id": str(uuid.uuid4()),
        "kind": "character",
        "name": "柳如烟",
        "aliases": ["如烟", "烟姐"],
        "biography": "江湖散修，出身市井，父母早亡，由老暗器师傅收养长大。性格豪爽洒脱，不拘小节，擅长轻功与暗器。在一次灵气回路意外中，她所用的暗器功法突然失灵，被陈墨发现是灵气回路中的'bug'导致。自此与陈墨结识，对他的编程思维感到新奇且信任。她代表江湖势力中自由不羁的一面，对门派和朝堂的规矩都不以为然。",
        "personality": "豪爽洒脱，敢爱敢恨，重义气轻生死。说话直来直去，不喜弯绕。表面大大咧咧，实则心思细腻，对朋友的安危格外在意。有市井智慧，能在复杂局面中找到生存之道。",
        "appearance": "容貌明艳，身形矫健。常着劲装，腰悬暗器囊，发束高马尾。笑起来爽朗大方，眼神中带着江湖儿女的锐利与豁达。",
        "abilities": "修为筑基中期，擅长轻功'踏烟步'与暗器'柳叶飞刀'。灵气感知敏锐，但功法结构粗糙，常因灵气回路不稳定而失灵。陈墨帮她'调试'功法后，修为稳步提升。",
        "motivation": "自由自在地生活，保护在意的人。对陈墨的编程思维感到新奇，认为这是能让江湖散修不再受大门派压制的契机。",
        "arc": "从'独来独往的江湖散修'逐渐转变为'灵气编程的江湖传播者'。起初只把陈墨当有趣的朋友，后在使用被'调试'过的功法后深感其价值，主动在江湖中传播灵气编程理念，成为陈墨在江湖势力的关键盟友。",
        "relations": {"陈墨": "江湖朋友→灵气编程受益者→倾心对象", "老暗器师傅": "养父，已故"},
        "faction": "江湖",
        "romanceArchetype": "江湖儿女型：自由不羁，敢爱敢恨，重义气轻生死",
    },
    {
        "id": str(uuid.uuid4()),
        "kind": "character",
        "name": "叶知秋",
        "aliases": ["知秋", "叶师姐"],
        "biography": "青篆门长老叶清玄之徒，沈青璃的师姐。修为金丹初期，是青篆门同辈中的佼佼者。冷静理性，对门派传承有深厚感情。起初对陈墨带来的'编程思维'持强烈保留态度，认为外来方法论会破坏功法传承的纯粹性。后因亲眼见证陈墨'调试'灵气回路解决了门派功法百年难题，态度逐渐转变。她代表门派势力中理性而忠诚的一面。",
        "personality": "冷静理性，外冷内热。做事严谨有条理，不轻易表态。一旦认定的事会坚持到底。对门派和师门有深厚忠诚，但不盲从。有强烈的责任感，认为保护门派传承是自己的使命。",
        "appearance": "容貌秀丽，气质清冷。常着青篆门弟子服饰，发束玉冠，佩长剑。眉目清冽如秋水，不笑时有一种拒人千里的冷感，但对待师妹沈青璃时会展露温柔。",
        "abilities": "修为金丹初期，精通青篆门核心功法'青篆阵解'与剑术'落叶剑法'。对灵气回路有深刻理解，是门派中少数能跟上陈墨'编程思维'的修士。擅长阵法分析与重构。",
        "motivation": "保护青篆门传承，证明门派功法的价值。对陈墨的编程思维从抗拒到接纳，最终认为传统与创新可以融合。",
        "arc": "从'传统功法的守护者'逐渐转变为'传统与创新的融合者'。起初强烈反对陈墨用编程思维重构功法，后因见证实效而转变，最终成为门派中推动功法现代化的核心力量，并在此过程中与陈墨建立起基于相互尊重的深厚关系。",
        "relations": {"陈墨": "质疑者→尊重者→深厚情谊", "沈青璃": "师妹", "叶清玄": "师父，青篆门长老"},
        "faction": "青篆门",
        "romanceArchetype": "知性冷静型：理性与感性的平衡者，外冷内热，忠诚而有原则",
    },
]

for char in characters:
    record = {
        **char,
        "schemaVersion": 8,
        "revision": 1,
        "createdAt": now,
        "updatedAt": now,
        "createdBy": "goal-loop-9-direct-create",
        "updatedBy": "goal-loop-9-direct-create",
        "projectId": PROJECT_ID,
    }
    c.execute(
        "INSERT INTO novel_records (collection, id, project_id, updated_at, payload) VALUES (?, ?, ?, ?, ?)",
        ('entities', record['id'], PROJECT_ID, now, json.dumps(record, ensure_ascii=False)),
    )
    print(f"created: {record['name']} (id={record['id'][:8]}...)")

db.commit()

# 验证
c.execute("SELECT id, payload FROM novel_records WHERE collection='entities' AND project_id=?", (PROJECT_ID,))
all_entities = c.fetchall()
print(f"\ntotal entities now: {len(all_entities)}")
for row in all_entities:
    e = json.loads(row[1])
    print(f"  {e.get('name')} (kind={e.get('kind')}, faction={e.get('faction', 'N/A')})")

db.close()
print("\ndone!")
