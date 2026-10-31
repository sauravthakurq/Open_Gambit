'use client';

import { useEffect, useRef, useCallback } from 'react';
import {
  doc, onSnapshot, updateDoc, collection,
  runTransaction, serverTimestamp, Timestamp
} from 'firebase/firestore';
import { db, isFirebaseConfigured } from '@/lib/firebase';
import { useGameStore } from '@/store/useGameStore';
import { useOnlineStore } from '@/store/useOnlineStore';
import { useAppStore } from '@/store/useAppStore';
import { OnlineGame, OnlineMove } from '@/lib/firebase-types';
import { Chess } from 'chess.js';
import { useToastStore } from '@/store/useToastStore';

/**
 * useOnlineGameSync — the heart of real-time online chess.
 * 
 * - Subscribes to `games/{gameId}` in Firestore via onSnapshot (never polls).
 * - Applies remote moves to the local chess.js board.
 * - Locks the board when it's not the player's turn.
 * - Handles draw offers, resignation, time-loss, and game-over.
 */
export function useOnlineGameSync() {
  const { onlineGameId, onlineGame, setOnlineGame, firebaseUser } = useOnlineStore();
  const { makeMove, resetGame } = useGameStore();
  const { setAppState } = useAppStore();
  const localFenRef = useRef<string>('');
  const unsubRef = useRef<(() => void) | null>(null);

  // My color in the online game
  const myColor: 'w' | 'b' | null = onlineGame && firebaseUser
    ? onlineGame.whiteUid === firebaseUser.uid ? 'w' : 'b'
    : null;

  useEffect(() => {
    if (!isFirebaseConfigured || !db || !onlineGameId) return;

    // Reset board at start of online game
    resetGame();
    localFenRef.current = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    const gameRef = doc(db, 'games', onlineGameId);
    const unsub = onSnapshot(gameRef, (snap) => {
      if (!snap.exists()) return;
      const game = { id: snap.id, ...snap.data() } as OnlineGame;
      const previousStatus = useOnlineStore.getState().onlineGame?.status;
      const previousResult = useOnlineStore.getState().onlineGame?.result;

      setOnlineGame(game);

      if (previousStatus === 'waiting' && game.status === 'active') {
        useToastStore.getState().addToast({ 
          type: 'success', 
          title: 'Opponent Joined!', 
          message: 'The match has started.' 
        });
      }

      if (game.status === 'completed' && game.result && !previousResult) {
        useToastStore.getState().addToast({
          type: 'info',
          title: 'Match Completed',
          message: `Game ended by ${game.endReason}.`
        });
      }

      // Apply new moves if FEN has changed
      if (game.fen && game.fen !== localFenRef.current) {
        // Reconstruct local board from Firestore FEN
        const newGame = new Chess(game.fen);
        // Use the store's resetGame and manually apply via store
        // We update fen through the store's internal game object
        useGameStore.setState((state) => {
          const updatedGame = new Chess(game.fen);
          return {
            game: updatedGame,
            fen: game.fen,
            pgn: game.pgn || '',
            turn: updatedGame.turn(),
            isCheck: updatedGame.inCheck(),
            isCheckmate: updatedGame.isCheckmate(),
            history: updatedGame.history({ verbose: true }) as any,
            gameResult: game.result
              ? {
                  winner: game.result === 'white' ? 'w' : game.result === 'black' ? 'b' : 'draw',
                  reason: game.endReason || null,
                }
              : { winner: null, reason: null },
          };
        });
        localFenRef.current = game.fen;
      }

      // Handle game over
      if (game.status === 'completed' && game.result) {
        // Game over UI handled by existing GameOverModal listening to gameResult
      }
    });

    unsubRef.current = unsub;
    return () => {
      unsub();
      unsubRef.current = null;
    };
  }, [onlineGameId]);

  /**
   * submitOnlineMove — called when the local player makes a move.
   * Validates locally first (chess.js), then writes to Firestore.
   */
  const submitOnlineMove = useCallback(async (
    from: string,
    to: string,
    promotion?: string
  ): Promise<boolean> => {
    if (!isFirebaseConfigured || !db || !onlineGameId || !firebaseUser || !onlineGame) return false;

    // Only allow moves on your turn
    if (onlineGame.turn !== myColor) return false;

    // Validate move locally
    const localGame = new Chess(onlineGame.fen);
    let moveResult;
    try {
      moveResult = localGame.move({ from, to, promotion: (promotion || 'q') as 'q' | 'r' | 'b' | 'n' });
    } catch {
      return false;
    }
    if (!moveResult) return false;

    const newFen = localGame.fen();
    const newPgn = localGame.pgn();
    const now = serverTimestamp() as Timestamp;
    const isGameOver = localGame.isGameOver();

    let result: OnlineGame['result'] = null;
    let endReason: OnlineGame['endReason'] = null;
    let newStatus: OnlineGame['status'] = 'active';

    if (isGameOver) {
      newStatus = 'completed';
      if (localGame.isCheckmate()) {
        result = localGame.turn() === 'w' ? 'black' : 'white';
        endReason = 'checkmate';
      } else if (localGame.isStalemate()) {
        result = 'draw'; endReason = 'stalemate';
      } else if (localGame.isThreefoldRepetition()) {
        result = 'draw'; endReason = 'repetition';
      } else if (localGame.isInsufficientMaterial()) {
        result = 'draw'; endReason = 'insufficient';
      } else if (localGame.isDraw()) {
        result = 'draw'; endReason = 'agreement';
      }
    }

    // Commit the move and the resulting board state atomically. A transaction
    // re-reads the game first, so two clients cannot both make the same turn.
    const gameRef = doc(db, 'games', onlineGameId);
    const moveRef = doc(collection(db, 'games', onlineGameId, 'moves'));

    await runTransaction(db, async (transaction) => {
      const latestSnapshot = await transaction.get(gameRef);
      if (!latestSnapshot.exists()) {
        throw new Error('Game no longer exists');
      }

      const latestGame = latestSnapshot.data() as OnlineGame;
      if (latestGame.status !== 'active' || latestGame.turn !== myColor) {
        throw new Error('It is no longer your turn');
      }

      transaction.set(moveRef, {
        moveIndex: (latestGame.moveCount || 0) + 1,
        san: moveResult.san,
        uci: from + to + (promotion || ''),
        from,
        to,
        promotion: promotion || undefined,
        fen: newFen,
        playedAt: now,
        playerUid: firebaseUser.uid,
      } satisfies Partial<OnlineMove>);

      transaction.update(gameRef, {
        fen: newFen,
        pgn: newPgn,
        turn: localGame.turn(),
        moveCount: (latestGame.moveCount || 0) + 1,
        lastMoveAt: now,
        status: newStatus,
        result,
        endReason,
      });
    });

    return true;
  }, [onlineGameId, firebaseUser, onlineGame, myColor]);

  /**
   * offerDraw — sends a draw offer to the opponent.
   */
  const offerDraw = useCallback(async () => {
    if (!db || !onlineGameId || !firebaseUser) return;
    
    // Play drawoffer sound
    import('@/lib/audioManager').then((m) => m.audioManager.play('drawoffer'));
    
    await updateDoc(doc(db, 'games', onlineGameId), {
      drawOfferBy: firebaseUser.uid,
    });
  }, [onlineGameId, firebaseUser]);

  /**
   * respondToDraw — accepts or declines draw offer.
   */
  const respondToDraw = useCallback(async (accept: boolean) => {
    if (!db || !onlineGameId) return;
    if (accept) {
      await updateDoc(doc(db, 'games', onlineGameId), {
        drawOfferBy: null,
        status: 'completed',
        result: 'draw',
        endReason: 'agreement',
      });
    } else {
      await updateDoc(doc(db, 'games', onlineGameId), {
        drawOfferBy: null,
      });
    }
  }, [onlineGameId]);

  /**
   * resign — the local player resigns.
   */
  const resign = useCallback(async () => {
    if (!db || !onlineGameId || !firebaseUser || !onlineGame) return;
    const winner = onlineGame.whiteUid === firebaseUser.uid ? 'black' : 'white';
    await updateDoc(doc(db, 'games', onlineGameId), {
      status: 'completed',
      result: winner,
      endReason: 'resignation',
    });
  }, [onlineGameId, firebaseUser, onlineGame]);

  return {
    myColor,
    submitOnlineMove,
    offerDraw,
    respondToDraw,
    resign,
    isMyTurn: onlineGame ? onlineGame.turn === myColor : false,
    onlineGame,
  };
}
