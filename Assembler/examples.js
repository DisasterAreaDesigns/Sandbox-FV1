// Example programs
const examples = {
    passthrough: `; Simple Pass-through
; Use this for BYPASS 0.hex on Sandbox Pedal!

ldax    adcl        ; read in the left input
wrax    dacl, 0.0   ; write to left output and clear acc
ldax    adcr        ; read in right input
wrax    dacr, 0.0   ; write to right output and clear`,

    delay: `; Simple Delay Effect
; POT0: delay mix, POT1: delay time, POT2: delay repeats

mem     delay   24000

equ     feedback reg0
equ     dfil reg1
equ     delaybase reg2

equ     delaylen    24000

rdax    feedback, 0.8   ; read end of long delay
mulx    pot2            ; scale feedback
rdax    adcl, 0.8       ; mix input
wra     delay, 0.0      ; write to long delay

rdax    pot1, 0.8       ; read delay pot
sof     0.95, 0.05      ; scale to max min
rdfx    dfil, 0.0001    ; filter delay time
wrax    dfil, 0     ; and save

or      delay*256       ; put address of delay in acc
wrax    delaybase, 0    ; save

or      delaylen*256    ; put length of delay in acc
mulx    dfil            ; pick location on delay line
rdax    delaybase, 1    ; add start address
wrax    addr_ptr, 0     ; set pointer pos

rmpa    1           ; get delay from pointer
wrax    feedback, 1.0   ; save to long delay

mulx    pot0            ; scale by mix pot
rdax    adcl, 1.0       ; add input
wrax    dacl, 0.0       ; write both channels`,

    chorus: `; Simple Mono Chorus
; POT0: chorus rate, POT1: chorus intensity, POT2: not used

mem     chodel  2048

skp     run, start      ; set up LFOs
wlds    sin0, 12, 100

start:

rdax    adcl, 1.0   ; read input
wra     chodel, 0.0 ; write to chorus delay

rdax    pot0, 1.0   ; read pot0 for rate
mulx    pot0        ; make log
sof     0.3, 0.0    ; scale chorus rate
wrax    sin0_rate, 0    ; set LFO rate

rdax    pot1, 1.0   ; read pot1 for depth
sof     0.02, 0.004 ; total range from 0.01 to 0.02
wrax    sin0_range, 0   ; set sine range

cho     rda, sin0, sin|reg|compc, chodel+800 ; do chorus using sin0 LFO
cho     rda, sin0, sin, chodel+801      ; interpolate using LFO

rdax    adcl, 0.8
wrax    dacl, 0.8   ; sum chorus and dry
wrax    dacr, 0.0   ; then write to both outputs`,

flanger: `flanger test`,

reverb: `reverb test`,

tremolo: `; Simple Mono Tremolo
; POT0: tremolo rage, POT1: tremolo depth, POT2: not used

equ temp reg0

skp run, start
; setup LFO
wlds    sin0, 177, 32767

start:

rdax    pot0, 1.0   ; get speed pot
mulx    pot0        ; make log so that speed feels natural
sof     0.49, 0.01  ; scale pot rate
wrax    sin0_rate, 0    ; set LFO rate

; read the sin0 LFO and apply depth control
; with depth at zero, the output should be a 1.0
; with depth at full, the output should be a sine wave from 0 to 1.0

cho rdal, 0     ; get sin0 value
sof 0.5, 0.5    ; reduce size to -0.5 - +0.5, add 0.5, now ranges 0-1
mulx    pot1    ; apply depth control
sof -0.999, 0.999   ; invert LF0
wrax    temp, 0.0   ; save scaled LFO

rdax    adcl, 1.0   ; get input
mulx    temp        ; scale by LFO

wrax    dacl, 0.0   ; write output`,
};