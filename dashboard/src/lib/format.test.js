import { describe, it, expect } from 'vitest'
import { formatCDMX, kdOf, kdaOf, recordStr, analyzeMatch } from './format'

describe('formatCDMX', () => {
  it('convierte un instante fijo a fecha/hora de CDMX (UTC-6 todo el año)', () => {
    // 2026-07-12T18:05:00Z -> 12:05 CDMX del mismo día
    expect(formatCDMX('2026-07-12T18:05:00.000Z')).toEqual({ dateStr: '12/07/2026', timeStr: '12:05' })
  })

  it('cruza medianoche al restar el offset', () => {
    // 2026-07-12T05:30:00Z -> 23:30 CDMX del día anterior (11)
    expect(formatCDMX('2026-07-12T05:30:00.000Z')).toEqual({ dateStr: '11/07/2026', timeStr: '23:30' })
  })
})

describe('kdOf / kdaOf', () => {
  it('divide normalmente cuando hay muertes', () => {
    expect(kdOf({ kills: 10, deaths: 5 })).toBe(2)
    expect(kdaOf({ kills: 10, deaths: 5, assists: 5 })).toBe(3)
  })

  it('con 0 muertes, devuelve kills/kills+assists tal cual (sin dividir)', () => {
    expect(kdOf({ kills: 7, deaths: 0 })).toBe(7)
    expect(kdaOf({ kills: 7, deaths: 0, assists: 3 })).toBe(10)
  })

  it('0 muertes y 0 kills -> 0', () => {
    expect(kdOf({ kills: 0, deaths: 0 })).toBe(0)
    expect(kdaOf({ kills: 0, deaths: 0, assists: 0 })).toBe(0)
  })
})

describe('recordStr', () => {
  it('sin wins definido -> placeholder', () => {
    expect(recordStr({})).toBe('—')
  })

  it('sin empates -> "wins-losses"', () => {
    expect(recordStr({ wins: 5, losses: 2, draws: 0 })).toBe('5-2')
  })

  it('con empates -> agrega sufijo E', () => {
    expect(recordStr({ wins: 5, losses: 2, draws: 1 })).toBe('5-2-1E')
  })
})

describe('analyzeMatch', () => {
  it('detecta ganador por score de equipo y ordena miembros por score', () => {
    const game = {
      players: [
        { gamertag: 'Alfa', team_id: 0, score: 20, kills: 10, deaths: 5, assists: 2 },
        { gamertag: 'Beta', team_id: 0, score: 30, kills: 15, deaths: 5, assists: 1 },
        { gamertag: 'Cyto', team_id: 1, score: 15, kills: 8, deaths: 6, assists: 0 },
        { gamertag: 'Delta', team_id: 1, score: 10, kills: 5, deaths: 6, assists: 0 },
      ],
    }
    const result = analyzeMatch(game)

    expect(result.isDraw).toBe(false)
    expect(result.band).toEqual({ text: 'Blue Team', cls: 'blue' })
    // Equipo ganador primero, y dentro de cada equipo ordenado por score desc.
    expect(result.teams[0].tid).toBe(0)
    expect(result.teams[0].members.map(m => m.gamertag)).toEqual(['Beta', 'Alfa'])
    // MVP = mejor KDA (Beta: 16/5=3.2 vs Alfa: 12/5=2.4 vs Cyto: 8/6=1.33 vs Delta: 5/6=0.83)
    expect(result.mvp.gamertag).toBe('Beta')
  })

  it('marca empate cuando ambos equipos tienen el mismo score total', () => {
    const game = {
      players: [
        { gamertag: 'Alfa', team_id: 0, score: 20, kills: 10, deaths: 5, assists: 0 },
        { gamertag: 'Beta', team_id: 1, score: 20, kills: 10, deaths: 5, assists: 0 },
      ],
    }
    const result = analyzeMatch(game)
    expect(result.isDraw).toBe(true)
    expect(result.band).toEqual({ text: 'Empate', cls: 'draw' })
  })

  it('desempate de MVP por score cuando el KDA es igual', () => {
    const game = {
      players: [
        { gamertag: 'Alfa', team_id: 0, score: 10, kills: 4, deaths: 2, assists: 0 }, // kda 2
        { gamertag: 'Beta', team_id: 1, score: 30, kills: 4, deaths: 2, assists: 0 }, // kda 2, score mayor
      ],
    }
    const result = analyzeMatch(game)
    expect(result.mvp.gamertag).toBe('Beta')
  })

  it('red team gana -> banda roja', () => {
    const game = {
      players: [
        { gamertag: 'Alfa', team_id: 0, score: 10, kills: 1, deaths: 1, assists: 0 },
        { gamertag: 'Beta', team_id: 1, score: 20, kills: 1, deaths: 1, assists: 0 },
      ],
    }
    const result = analyzeMatch(game)
    expect(result.band).toEqual({ text: 'Red Team', cls: 'red' })
  })
})
