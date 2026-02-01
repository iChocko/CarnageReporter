import React, { useState } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'
import { X } from 'lucide-react'

const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY)

const PREDEFINED_AMOUNTS = [
    { value: 500, label: '$5' },
    { value: 1000, label: '$10' },
    { value: 2000, label: '$20' }
]

const PaymentForm = ({ amount, onClose }) => {
    const stripe = useStripe()
    const elements = useElements()
    const [processing, setProcessing] = useState(false)
    const [message, setMessage] = useState('')

    const handleSubmit = async (e) => {
        e.preventDefault()

        if (!stripe || !elements) {
            return
        }

        setProcessing(true)
        setMessage('')

        const { error } = await stripe.confirmPayment({
            elements,
            confirmParams: {
                return_url: `${window.location.origin}?payment=success`,
            },
        })

        if (error) {
            setMessage(error.message)
            setProcessing(false)
        }
    }

    return (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <div style={{
                background: 'rgba(255, 255, 255, 0.03)',
                padding: '1rem',
                border: '1px solid var(--border-color)'
            }}>
                <PaymentElement />
            </div>

            {message && (
                <div style={{
                    padding: '0.75rem',
                    background: 'rgba(255, 92, 92, 0.1)',
                    border: '1px solid #ff5c5c',
                    color: '#ff5c5c',
                    fontSize: '0.85rem'
                }}>
                    {message}
                </div>
            )}

            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'flex-end' }}>
                <button
                    type="button"
                    onClick={onClose}
                    disabled={processing}
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: 'transparent',
                        border: '1px solid var(--border-color)',
                        color: 'var(--text-secondary)',
                        fontFamily: 'Outfit',
                        fontSize: '0.875rem',
                        cursor: 'pointer',
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                        transition: 'all 0.2s'
                    }}
                >
                    Cancel
                </button>
                <button
                    type="submit"
                    disabled={!stripe || processing}
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: processing ? 'var(--accent-blue)' : 'var(--accent-cyan)',
                        border: 'none',
                        color: '#000',
                        fontFamily: 'Outfit',
                        fontWeight: 700,
                        fontSize: '0.875rem',
                        cursor: processing ? 'not-allowed' : 'pointer',
                        textTransform: 'uppercase',
                        letterSpacing: '0.1em',
                        transition: 'all 0.2s',
                        opacity: processing ? 0.6 : 1
                    }}
                >
                    {processing ? 'Processing...' : `Donate ${PREDEFINED_AMOUNTS.find(a => a.value === amount)?.label || `$${amount / 100}`}`}
                </button>
            </div>
        </form>
    )
}

export const StripePaymentModal = ({ isOpen, onClose }) => {
    const [clientSecret, setClientSecret] = useState(null)
    const [selectedAmount, setSelectedAmount] = useState(1000)
    const [customAmount, setCustomAmount] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')

    const handleAmountSelect = (amount) => {
        setSelectedAmount(amount)
        setCustomAmount('')
        setClientSecret(null)
    }

    const handleCustomAmountChange = (e) => {
        const value = e.target.value.replace(/[^0-9]/g, '')
        setCustomAmount(value)
        if (value) {
            setSelectedAmount(parseInt(value) * 100)
        }
        setClientSecret(null)
    }

    const initializePayment = async () => {
        setLoading(true)
        setError('')

        try {
            const response = await fetch('/api/stripe/create-payment-intent', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: selectedAmount })
            })

            const data = await response.json()

            if (!response.ok) {
                throw new Error(data.error || 'Failed to initialize payment')
            }

            setClientSecret(data.clientSecret)
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }

    if (!isOpen) return null

    return (
        <div
            style={{
                position: 'fixed',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                background: 'rgba(5, 8, 10, 0.95)',
                backdropFilter: 'blur(10px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                zIndex: 9999,
                padding: '1rem'
            }}
            onClick={onClose}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                style={{
                    background: 'var(--bg-card)',
                    border: '2px solid var(--accent-blue)',
                    maxWidth: '500px',
                    width: '100%',
                    padding: '2rem',
                    position: 'relative'
                }}
            >
                <button
                    onClick={onClose}
                    style={{
                        position: 'absolute',
                        top: '1rem',
                        right: '1rem',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        padding: '0.5rem',
                        display: 'flex',
                        alignItems: 'center'
                    }}
                >
                    <X size={20} />
                </button>

                <h2 style={{
                    fontFamily: 'Outfit',
                    fontSize: '1.5rem',
                    marginBottom: '0.5rem',
                    color: 'var(--accent-cyan)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em'
                }}>
                    Support Carnage Reporter
                </h2>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '2rem' }}>
                    Your donation helps keep the servers running
                </p>

                {!clientSecret ? (
                    <>
                        <div style={{ marginBottom: '1.5rem' }}>
                            <label style={{
                                display: 'block',
                                fontSize: '0.75rem',
                                color: 'var(--text-secondary)',
                                textTransform: 'uppercase',
                                letterSpacing: '0.1em',
                                marginBottom: '0.75rem'
                            }}>
                                Select Amount
                            </label>
                            <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem' }}>
                                {PREDEFINED_AMOUNTS.map(({ value, label }) => (
                                    <button
                                        key={value}
                                        onClick={() => handleAmountSelect(value)}
                                        style={{
                                            flex: 1,
                                            padding: '0.75rem',
                                            background: selectedAmount === value && !customAmount ? 'var(--accent-cyan)' : 'rgba(255, 255, 255, 0.05)',
                                            border: `1px solid ${selectedAmount === value && !customAmount ? 'var(--accent-cyan)' : 'var(--border-color)'}`,
                                            color: selectedAmount === value && !customAmount ? '#000' : 'var(--text-primary)',
                                            fontFamily: 'Outfit',
                                            fontWeight: 700,
                                            fontSize: '1rem',
                                            cursor: 'pointer',
                                            transition: 'all 0.2s'
                                        }}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <input
                                type="text"
                                placeholder="Custom amount ($)"
                                value={customAmount}
                                onChange={handleCustomAmountChange}
                                style={{
                                    width: '100%',
                                    padding: '0.75rem',
                                    background: 'rgba(255, 255, 255, 0.05)',
                                    border: `1px solid ${customAmount ? 'var(--accent-cyan)' : 'var(--border-color)'}`,
                                    color: 'var(--text-primary)',
                                    fontFamily: 'Inter',
                                    fontSize: '0.875rem',
                                    outline: 'none'
                                }}
                            />
                        </div>

                        {error && (
                            <div style={{
                                padding: '0.75rem',
                                background: 'rgba(255, 92, 92, 0.1)',
                                border: '1px solid #ff5c5c',
                                color: '#ff5c5c',
                                fontSize: '0.85rem',
                                marginBottom: '1rem'
                            }}>
                                {error}
                            </div>
                        )}

                        <button
                            onClick={initializePayment}
                            disabled={loading}
                            style={{
                                width: '100%',
                                padding: '1rem',
                                background: loading ? 'var(--accent-blue)' : 'var(--accent-cyan)',
                                border: 'none',
                                color: '#000',
                                fontFamily: 'Outfit',
                                fontWeight: 700,
                                fontSize: '0.875rem',
                                cursor: loading ? 'not-allowed' : 'pointer',
                                textTransform: 'uppercase',
                                letterSpacing: '0.1em',
                                transition: 'all 0.2s',
                                opacity: loading ? 0.6 : 1
                            }}
                        >
                            {loading ? 'Initializing...' : 'Continue to Payment'}
                        </button>
                    </>
                ) : (
                    <Elements stripe={stripePromise} options={{
                        clientSecret, appearance: {
                            theme: 'night',
                            variables: {
                                colorPrimary: '#00f2ff',
                                colorBackground: '#141b22',
                                colorText: '#e0e6ed',
                                colorDanger: '#ff5c5c',
                                fontFamily: 'Inter, sans-serif',
                                spacingUnit: '4px',
                                borderRadius: '0px'
                            }
                        }
                    }}>
                        <PaymentForm amount={selectedAmount} onClose={onClose} />
                    </Elements>
                )}
            </div>
        </div>
    )
}
