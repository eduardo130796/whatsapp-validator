import React, { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';

/**
 * Componente LogTerminal
 * Exibe logs em tempo real recebidos via WebSocket.
 */
const LogTerminal = ({ socketUrl = '/' }) => {
    const [logs, setLogs] = useState([]);
    const terminalRef = useRef(null);

    useEffect(() => {
        const socket = io(socketUrl);

        socket.on('log', (newLog) => {
            setLogs((prevLogs) => [newLog, ...prevLogs].slice(0, 100)); // Mantém os últimos 100
        });

        return () => socket.disconnect();
    }, [socketUrl]);

    // Cores baseadas no nível do log
    const getLogColor = (level) => {
        switch (level) {
            case 'success': return '#22c55e';
            case 'warning': return '#fbbf24';
            case 'error': return '#f87171';
            default: return '#94a3b8'; // info
        }
    };

    const terminalStyle = {
        backgroundColor: '#020617',
        color: '#f8fafc',
        padding: '15px',
        borderRadius: '12px',
        fontFamily: 'monospace',
        fontSize: '13px',
        height: '300px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column'
    };

    const logItemStyle = {
        marginBottom: '4px',
        lineHeight: '1.4'
    };

    const timestampStyle = {
        color: '#64748b',
        marginRight: '8px'
    };

    const typeStyle = {
        fontWeight: 'bold',
        marginRight: '8px',
        textTransform: 'uppercase'
    };

    return (
        <div style={{ marginTop: '20px' }}>
            <h3 style={{ color: '#94a3b8', marginBottom: '10px' }}>📟 Logs do Sistema</h3>
            <div style={terminalStyle} ref={terminalRef}>
                {logs.length === 0 && (
                    <div style={{ color: '#475569', fontStyle: 'italic' }}>
                        Aguardando logs...
                    </div>
                )}
                {logs.map((log, index) => (
                    <div key={index} style={{ ...logItemStyle, color: getLogColor(log.level) }}>
                        <span style={timestampStyle}>
                            [{new Date(log.timestamp).toLocaleTimeString()}]
                        </span>
                        <span style={typeStyle}>
                            [{log.type}]
                        </span>
                        <span>{log.message}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

export default LogTerminal;
