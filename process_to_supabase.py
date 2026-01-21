import os
from lxml import etree as ET
import psycopg2
from datetime import datetime
import re

def get_map_name(filename):
    maps = {
        "asq_chill": "Narrows",
        "asq_constru": "Construct",
        "asq_guardia": "Guardian",
        "asq_cyberdy": "The Pit",
        "asq_warehou": "Foundry (Onslaught)",
        "asq_midship": "Heretic",
        "asq_epitaph": "Epitaph",
        "asq_high_ground": "High Ground",
        "asq_isolation": "Isolation",
        "asq_last_resort": "Last Resort",
        "asq_sandtrap": "Sandtrap",
        "asq_snowbound": "Snowbound",
        "asq_the_pit": "The Pit",
        "asq_valhalla": "Valhalla",
    }
    for key, val in maps.items():
        if key in filename:
            return val
    return "Unknown"

def parse_xml(file_path):
    tree = ET.parse(file_path)
    root = tree.getroot()
    
    game_data = {
        "game_unique_id": root.find("GameUniqueId").attrib["GameUniqueId"],
        "game_enum": int(root.find("GameEnum").attrib["mGameEnum"]),
        "is_matchmaking": root.find("IsMatchmaking").attrib["IsMatchmaking"].lower() == "true",
        "has_network_members_in_party": root.find("mHasNetworkMembersInParty").attrib["mHasNetworkMembersInParty"].lower() == "true",
        "party_size": int(root.find("mPartySize").attrib["mPartySize"]),
        "last_match_incomplete": root.find("mLastMatchIncomplete").attrib["mLastMatchIncomplete"].lower() == "true",
        "is_teams_enabled": root.find("IsTeamsEnabled").attrib["IsTeamsEnabled"].lower() == "true",
        "hopper_id": int(root.find("HopperId").attrib["HopperId"]),
        "hopper_name": root.find("HopperName").attrib["HopperName"],
        "game_type_name": root.find("GameTypeName").attrib["GameTypeName"]
    }
    
    # Try to extract timestamp from filename
    # Format: CYR1X-2026-01-20-18-14-04-mpcarnagereport1_3528_0_0.xml
    match = re.search(r"(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2})", os.path.basename(file_path))
    if match:
        ts_str = match.group(1)
        game_data["timestamp"] = datetime.strptime(ts_str, "%Y-%m-%d-%H-%M-%S")
    else:
        game_data["timestamp"] = datetime.fromtimestamp(os.path.getmtime(file_path))
        
    players = []
    for player_node in root.find("Players").findall("Player"):
        p_attr = player_node.attrib
        player = {
            "xbox_user_id": p_attr["mXboxUserId"],
            "is_guest": p_attr["isGuest"].lower() == "true",
            "game_mode": int(p_attr["mGameMode"]),
            "gamertag": p_attr["mGamertagText"],
            "clan_tag": p_attr["ClantagText"],
            "service_id": p_attr["ServiceId"],
            "team_id": int(p_attr["mTeamId"]),
            "score": int(p_attr["Score"]),
            "standing": int(p_attr["mStanding"]),
            "total_medal_count": int(p_attr["mTotalMedalCount"]),
            "kills": int(p_attr["mKills"]),
            "deaths": int(p_attr["mDeaths"]),
            "assists": int(p_attr["mAssists"]),
            "betrayals": int(p_attr["mBetrayals"]),
            "suicides": int(p_attr["mSuicides"]),
            "most_kills_in_a_row": int(p_attr["mMostKillsInARow"]),
            "seconds_alive": int(p_attr["mSecondsAlive"]),
            "kills_weapon": int(p_attr["mKillsWeapon"]),
            "kills_grenade": int(p_attr["mKillsGrenade"]),
            "kills_melee": int(p_attr["mKillsMelee"]),
            "kills_other": int(p_attr["mKillsOther"]),
            "completed_game": int(p_attr["mCompletedGame"]),
            "seconds_played": int(p_attr["mSecondsPlayed"]),
            "killed_most_player_index": int(p_attr["mKilledMostPlayerIndex"]),
            "killed_most_player_count": int(p_attr["mKilledMostPlayerCount"]),
            "most_killed_by_player_index": int(p_attr["mMostKilledByPlayerIndex"]),
            "most_killed_by_player_count": int(p_attr["mMostKilledByPlayerCount"]),
            "most_used_weapon": int(p_attr["mMostUsedWeapon"]),
            "most_used_weapon_count": int(p_attr["mMostUsedWeaponCount"]),
            "medals": [],
            "custom_stats": []
        }
        
        # Parse Medals
        medals_node = player_node.find("MedalsCount")
        if medals_node is not None:
            for medal in medals_node.findall("Medal"):
                m_attr = medal.attrib
                count = int(m_attr["mCount"])
                if count > 0:
                    player["medals"].append({
                        "medal_id": int(m_attr["mId"]),
                        "count": count
                    })
        
        # Parse Custom Stats
        custom_node = player_node.find("CustomStats")
        if custom_node is not None:
            for stat in custom_node.findall("CustomStat"):
                s_attr = stat.attrib
                if s_attr["mStatName"]:
                    player["custom_stats"].append({
                        "stat_name": s_attr["mStatName"],
                        "value_display": s_attr["mValueForDisplay"]
                    })
        
        players.append(player)
        
    return game_data, players

def upload_to_supabase(conn_str, game_data, players, map_name):
    try:
        conn = psycopg2.connect(conn_str)
        cur = conn.cursor()
        
        # Insert Game
        cur.execute("""
            INSERT INTO h3mcc.games (
                game_unique_id, game_enum, is_matchmaking, has_network_members_in_party, 
                party_size, last_match_incomplete, is_teams_enabled, hopper_id, 
                hopper_name, game_type_name, map_name, timestamp
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (game_unique_id) DO UPDATE SET map_name = EXCLUDED.map_name;
        """, (
            game_data["game_unique_id"], game_data["game_enum"], game_data["is_matchmaking"],
            game_data["has_network_members_in_party"], game_data["party_size"], 
            game_data["last_match_incomplete"], game_data["is_teams_enabled"], 
            game_data["hopper_id"], game_data["hopper_name"], game_data["game_type_name"],
            map_name, game_data["timestamp"]
        ))
        
        for p in players:
            # Insert Player
            cur.execute("""
                INSERT INTO h3mcc.players (
                    game_unique_id, xbox_user_id, is_guest, game_mode, gamertag, 
                    clan_tag, service_id, team_id, score, standing, total_medal_count, 
                    kills, deaths, assists, betrayals, suicides, most_kills_in_a_row, 
                    seconds_alive, kills_weapon, kills_grenade, kills_melee, kills_other, 
                    completed_game, seconds_played, killed_most_player_index, 
                    killed_most_player_count, most_killed_by_player_index, 
                    most_killed_by_player_count, most_used_weapon, most_used_weapon_count
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id;
            """, (
                game_data["game_unique_id"], p["xbox_user_id"], p["is_guest"], p["game_mode"],
                p["gamertag"], p["clan_tag"], p["service_id"], p["team_id"], p["score"],
                p["standing"], p["total_medal_count"], p["kills"], p["deaths"], p["assists"],
                p["betrayals"], p["suicides"], p["most_kills_in_a_row"], p["seconds_alive"],
                p["kills_weapon"], p["kills_grenade"], p["kills_melee"], p["kills_other"],
                p["completed_game"], p["seconds_played"], p["killed_most_player_index"],
                p["killed_most_player_count"], p["most_killed_by_player_index"],
                p["most_killed_by_player_count"], p["most_used_weapon"], p["most_used_weapon_count"]
            ))
            player_id = cur.fetchone()[0]
            
            # Insert Medals
            for m in p["medals"]:
                cur.execute("INSERT INTO h3mcc.player_medals (player_id, medal_id, count) VALUES (%s, %s, %s)",
                           (player_id, m["medal_id"], m["count"]))
            
            # Insert Custom Stats
            for s in p["custom_stats"]:
                cur.execute("INSERT INTO h3mcc.player_custom_stats (player_id, stat_name, value_display) VALUES (%s, %s, %s)",
                           (player_id, s["stat_name"], s["value_display"]))
        
        conn.commit()
        cur.close()
        conn.close()
        print(f"Uploaded game {game_data['game_unique_id']} ({map_name}) successfully.")
    except Exception as e:
        print(f"Error uploading game {game_data.get('game_unique_id', 'unknown')}: {e}")

if __name__ == "__main__":
    with open("success_conn.txt", "r") as f:
        conn_str = f.read().strip()
    
    maps_dir = "Maps_to_Rename"
    xml_files = [f for f in os.listdir(maps_dir) if f.endswith(".xml") and ("mpcarnagereport" in f or "asq_" in f) and "test_trigger" not in f]
    
    for f in xml_files:
        path = os.path.join(maps_dir, f)
        print(f"Processing {path}...")
        try:
            game_data, players = parse_xml(path)
            # We don't have the .mov here directly but we can try to guess from common strings if the user renamed them, 
            # otherwise we'll check the timestamps against the mapping we did earlier manually.
            # For now, I'll use the get_map_name logic.
            map_name = get_map_name(f)
            upload_to_supabase(conn_str, game_data, players, map_name)
        except Exception as e:
            print(f"Failed to process {f}: {e}")
