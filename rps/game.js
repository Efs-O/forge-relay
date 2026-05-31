let wins = 0;
let losses = 0;
let ties = 0;

const winsDisplay = document.getElementById('wins');
const lossesDisplay = document.getElementById('losses');
const tiesDisplay = document.getElementById('ties');
const resultDisplay = document.getElementById('result');
const computerMoveDisplay = document.getElementById('computer-move');
const rockBtn = document.getElementById('rock');
const paperBtn = document.getElementById('paper');
const scissorsBtn = document.getElementById('scissors');
const resetBtn = document.getElementById('reset');

function updateScore() {
    winsDisplay.textContent = wins;
    lossesDisplay.textContent = losses;
    tiesDisplay.textContent = ties;
}

function getComputerChoice() {
    const choices = ['rock', 'paper', 'scissors'];
    const randomIndex = Math.floor(Math.random() * choices.length);
    return choices[randomIndex];
}

function playRound(playerChoice) {
    const computerChoice = getComputerChoice();
    computerMoveDisplay.textContent = `Computer chose: ${computerChoice.charAt(0).toUpperCase() + computerChoice.slice(1)}`;

    if (playerChoice === computerChoice) {
        resultDisplay.textContent = "It's a tie!";
        ties++;
    } else if (
        (playerChoice === 'rock' && computerChoice === 'scissors') ||
        (playerChoice === 'paper' && computerChoice === 'rock') ||
        (playerChoice === 'scissors' && computerChoice === 'paper')
    ) {
        resultDisplay.textContent = "You win!";
        wins++;
    } else {
        resultDisplay.textContent = "You lose!";
        losses++;
    }

    updateScore();
}

rockBtn.addEventListener('click', () => playRound('rock'));
paperBtn.addEventListener('click', () => playRound('paper'));
scissorsBtn.addEventListener('click', () => playRound('scissors'));

resetBtn.addEventListener('click', () => {
    wins = 0;
    losses = 0;
    ties = 0;
    updateScore();
    resultDisplay.textContent = "Choose your move!";
    computerMoveDisplay.textContent = "";
});
