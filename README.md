# Carnage Reporter

![Image of Carnage Reporter stream overlay](https://raw.githubusercontent.com/CYRiXplaysHalo/CarnageReporter/b755295ff99c067f6ac80f18b0a4116294b6d5a1/image.png)

### What is Carnage Reporter?

This is an app that monitors Halo 3 MCC PC match carnage reports, generates PNG summaries, sends them to Discord, and uploads comprehensive stats to Supabase for tracking and analysis.

The app saves your MCC PC carnage report files into a non-temporary directory to preserve them since the game simply overwrites this file in its temporary directory after a new game is completed. This allows you to maintain detailed session stats and contribute to a comprehensive database.

### Why should I use this?

With this application we create a database of in-depth stats for each game that allows us to better understand Halo 3 MCC PC. You can:

- **Track your career stats**: Monitor your progress across all matches with detailed breakdowns of kills, deaths, assists, and more
- **Share match results**: Automatically post match summaries to Discord with beautiful PNG graphics
- **Contribute to community analytics**: Help build a comprehensive database of Halo 3 stats including map distribution, balance analysis, and player trends
- **Real-time notifications**: Get instant Discord notifications when matches complete

As long as one person per game submits stats, we can record stats for all players in that game.

### How does it work?

Halo 3 MCC PC generates an XML file after each multiplayer game containing every statistic and medal for each player and team. This script monitors the folder where these files are created, processes them, generates visual summaries, sends them to Discord, and uploads the data to Supabase for permanent storage and analysis.
