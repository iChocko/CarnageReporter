import psycopg2
from psycopg2 import sql
import os
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

def create_schema(conn_string):
    conn = psycopg2.connect(conn_string)
    cur = conn.cursor()
    
    # Create schema
    cur.execute("CREATE SCHEMA IF NOT EXISTS h3mcc;")
    
    # Create games table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS h3mcc.games (
        game_unique_id UUID PRIMARY KEY,
        game_enum INTEGER,
        is_matchmaking BOOLEAN,
        has_network_members_in_party BOOLEAN,
        party_size INTEGER,
        last_match_incomplete BOOLEAN,
        is_teams_enabled BOOLEAN,
        hopper_id INTEGER,
        hopper_name TEXT,
        game_type_name TEXT,
        map_name TEXT,
        timestamp TIMESTAMPTZ DEFAULT NOW()
    );
    """)
    
    # Create players table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS h3mcc.players (
        id BIGSERIAL PRIMARY KEY,
        game_unique_id UUID REFERENCES h3mcc.games(game_unique_id),
        xbox_user_id TEXT,
        is_guest BOOLEAN,
        game_mode INTEGER,
        gamertag TEXT,
        clan_tag TEXT,
        service_id TEXT,
        team_id INTEGER,
        score INTEGER,
        standing INTEGER,
        total_medal_count INTEGER,
        kills INTEGER,
        deaths INTEGER,
        assists INTEGER,
        betrayals INTEGER,
        suicides INTEGER,
        most_kills_in_a_row INTEGER,
        seconds_alive INTEGER,
        kills_weapon INTEGER,
        kills_grenade INTEGER,
        kills_melee INTEGER,
        kills_other INTEGER,
        completed_game INTEGER,
        seconds_played INTEGER,
        killed_most_player_index INTEGER,
        killed_most_player_count INTEGER,
        most_killed_by_player_index INTEGER,
        most_killed_by_player_count INTEGER,
        most_used_weapon INTEGER,
        most_used_weapon_count INTEGER
    );
    """)
    
    # Create player_medals table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS h3mcc.player_medals (
        id BIGSERIAL PRIMARY KEY,
        player_id BIGINT REFERENCES h3mcc.players(id),
        medal_id INTEGER,
        count INTEGER
    );
    """)
    
    # Create player_custom_stats table
    cur.execute("""
    CREATE TABLE IF NOT EXISTS h3mcc.player_custom_stats (
        id BIGSERIAL PRIMARY KEY,
        player_id BIGINT REFERENCES h3mcc.players(id),
        stat_name TEXT,
        value_display TEXT
    );
    """)
    
    conn.commit()
    print("Schema and tables created successfully.")
    cur.close()
    conn.close()

if __name__ == "__main__":
    project_id = os.getenv("SUPABASE_PROJECT_ID")
    password = os.getenv("SUPABASE_PASSWORD")
    
    if not project_id or not password:
        print("Error: SUPABASE_PROJECT_ID or SUPABASE_PASSWORD not found in environment variables.")
        exit(1)

    # Expanded list of regions
    regions = ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "sa-east-1", "eu-central-1", "eu-west-1"]
    ports = [5432, 6543]
    
    success = False
    for region in regions:
        for port in ports:
            host = f"aws-0-{region}.pooler.supabase.com"
            # User for pooled connections must be postgres.[PROJECT_ID]
            user = f"postgres.{project_id}"
            conn_str = f"postgresql://{user}:{password}@{host}:{port}/postgres"
            
            print(f"Attempting to connect to {host}:{port}...")
            try:
                create_schema(conn_str)
                success = True
                print(f"Successfully connected and initialized via {region} pooler on port {port}.")
                with open("success_conn.txt", "w") as f:
                    f.write(conn_str)
                break
            except Exception as e:
                print(f"Failed {region}:{port} - {e}")
                continue
        if success:
            break
            
    if not success:
        print("All pooled regions failed. One last try with direct host (IPv6 fallback)...")
        try:
            create_schema(f"postgresql://postgres:{password}@db.{project_id}.supabase.co:5432/postgres")
        except Exception as e:
            print(f"Direct connection failed: {e}")
